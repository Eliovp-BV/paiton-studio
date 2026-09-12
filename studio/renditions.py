"""Non-generative, CPU-only delivery copies. Source pixels/audio stay immutable."""
import hashlib
import json
import re
import shutil
import threading
import time

import av
from PIL import Image, ImageOps
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal

from .resources import Lease
from .store import uid

PRESETS = {
    'portrait': {'label': 'Portrait · 9:16', 'width': 720, 'height': 1280},
    'square': {'label': 'Square · 1:1', 'width': 720, 'height': 720},
    'wide': {'label': 'Wide · 16:9', 'width': 1280, 'height': 720},
}
TERMINAL = ('completed', 'failed', 'cancelled', 'interrupted')


class RenditionInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    source_id: str
    preset: Literal['portrait', 'square', 'wide'] = 'portrait'
    fit: Literal['contain', 'cover'] = 'contain'
    focal_x: float = Field(default=.5, ge=0, le=1, allow_inf_nan=False)
    audio: Literal['preserve', 'mute'] = 'preserve'


class RenderCancelled(Exception):
    pass


def reframe(image, width, height, fit, focal_x):
    options = dict(method=Image.Resampling.LANCZOS, centering=(focal_x, .5))
    if fit == 'cover': return ImageOps.fit(image, (width, height), **options)
    return ImageOps.pad(image, (width, height), color='#141415', **options)


def encode_copy(source, destination, request, update, cancelled):
    """Keep source frame timestamps; stream-copy AAC audio without new inference."""
    preset = PRESETS[request['preset']]
    width, height = preset['width'], preset['height']
    with av.open(str(source)) as incoming:
        if len(incoming.streams.video) != 1: raise ValueError('Choose a video with one picture stream.')
        video = incoming.streams.video[0]
        duration = float(video.duration * video.time_base) if video.duration and video.time_base else 0
        rate = video.average_rate
        if not 0 < duration <= 60 or not rate or not 1 <= float(rate) <= 60 or video.width * video.height > 4096 * 2160:
            raise ValueError('Delivery copies support complete clips up to 60 seconds and 60 fps.')
        audio = incoming.streams.audio[0] if incoming.streams.audio and request['audio'] == 'preserve' else None
        if audio and audio.codec_context.name != 'aac':
            raise ValueError('This audio codec cannot be copied into MP4. Choose Mute or keep the original file.')
        video.codec_context.thread_count = 2
        frames = 0
        with av.open(str(destination), 'w', format='mp4', options={'movflags': '+faststart'}) as output:
            encoded = output.add_stream('libx264', rate=rate)
            encoded.width, encoded.height = width, height
            encoded.pix_fmt = 'yuv420p'
            encoded.time_base = video.time_base
            encoded.codec_context.thread_count = 2
            encoded.options = {'preset': 'veryfast', 'crf': '20'}
            copied_audio = output.add_stream_from_template(audio) if audio else None
            for packet in incoming.demux([video] + ([audio] if audio else [])):
                if cancelled(): raise RenderCancelled()
                if audio and packet.stream.index == audio.index:
                    if packet.dts is not None:
                        packet.stream = copied_audio
                        output.mux(packet)
                    continue
                for frame in packet.decode():
                    if cancelled(): raise RenderCancelled()
                    image = reframe(frame.to_image(), width, height, request['fit'], request['focal_x'])
                    result = av.VideoFrame.from_image(image)
                    result.pts, result.time_base = frame.pts, frame.time_base
                    for encoded_packet in encoded.encode(result): output.mux(encoded_packet)
                    frames += 1
                    if frames % 12 == 0:
                        update(min(.98, max(0, float(frame.pts * frame.time_base) / duration)))
            for packet in encoded.encode(): output.mux(packet)
        if not frames: raise ValueError('The source video has no readable frames.')
    # Validate the actual completed streams, including audio, before registration.
    decoded = audio_samples = 0
    with av.open(str(destination)) as result:
        stream = result.streams.video[0]
        actual_duration = float(stream.duration * stream.time_base)
        for packet in result.demux():
            if cancelled(): raise RenderCancelled()
            for frame in packet.decode():
                if isinstance(frame, av.VideoFrame): decoded += 1
                elif isinstance(frame, av.AudioFrame): audio_samples += frame.samples
        if decoded != frames or (audio and not audio_samples) or abs(actual_duration - duration) > .2:
            raise ValueError('The delivery copy did not pass complete media validation.')
    return dict(width=width, height=height, duration=actual_duration, fps=float(rate), audio=bool(audio),
                codec='h264', decoded_frames=decoded, audio_samples=audio_samples,
                audio_processing='copied AAC' if audio else 'no audio', processing='CPU resize and H.264 encode; no AI generation')


class Renditions:
    def __init__(self, store):
        self.store = store
        self.closed = threading.Event()
        self.thread = None
        self.lock = None
        with store.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS renditions(id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id), request TEXT NOT NULL, state TEXT NOT NULL, message TEXT NOT NULL, progress REAL, asset TEXT, cancel INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL, updated REAL NOT NULL)')

    def get(self, identity):
        with self.store.connect() as db:
            row = db.execute('SELECT * FROM renditions WHERE id=?', (identity,)).fetchone()
        if not row: raise ValueError('Delivery request not found.')
        result = dict(row)
        result['request'] = json.loads(result['request'])
        return result

    def list(self, project):
        self.store.project(project)
        # progress is numeric, whereas the generic store decodes job progress JSON.
        with self.store.connect() as db:
            rows = [dict(row) for row in db.execute('SELECT * FROM renditions WHERE project=? ORDER BY created DESC LIMIT 30', (project,))]
        for row in rows: row['request'] = json.loads(row['request'])
        return rows

    def submit(self, project, body):
        asset = self.store.asset(body.source_id, project)
        if asset['kind'] != 'video': raise ValueError('Choose a saved project video to prepare for sharing.')
        if shutil.disk_usage(self.store.root).free < 512 * 1024**2:
            raise ValueError('Free at least 512 MB on the project disk before preparing a delivery copy.')
        request = {**body.model_dump(), 'source_sha256': asset['metadata']['sha256'], 'source_name': asset['name']}
        identity, now = uid(), time.time()
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            count = db.execute("SELECT count(*) FROM renditions WHERE state IN ('queued','encoding','cancelling')").fetchone()[0]
            if count >= 10: raise ValueError('Ten delivery copies are already waiting. Let one finish before adding another.')
            db.execute('INSERT INTO renditions(id,project,request,state,message,created,updated) VALUES(?,?,?,?,?,?,?)',
                       (identity, project, json.dumps(request), 'queued', 'Waiting for the local media encoder.', now, now))
        return self.get(identity)

    def cancel(self, identity):
        with self.store.connect() as db:
            db.execute("UPDATE renditions SET cancel=1,state=CASE WHEN state='queued' THEN 'cancelled' ELSE 'cancelling' END,message='Stopping the delivery copy.',updated=? WHERE id=? AND state IN ('queued','encoding','cancelling')", (time.time(), identity))
        return self.get(identity)

    def start(self):
        self.lock = Lease(self.store.root / 'media-worker.lock')
        if not self.lock.acquire(): raise RuntimeError('Another Studio media encoder is already using this project store.')
        with self.store.connect() as db:
            db.execute("UPDATE renditions SET state='interrupted',message='Studio stopped during encoding. Create a new delivery copy to retry.' WHERE state IN ('encoding','cancelling')")
            finished = db.execute("SELECT id FROM renditions WHERE state IN ('completed','failed','cancelled','interrupted')").fetchall()
        # A hard process exit can bypass the encoder's finally block. Remove
        # only temporary outputs belonging to known, stopped requests.
        for row in finished:
            if re.fullmatch('[0-9a-f]{32}', row['id']):
                (self.store.root / 'renditions' / (row['id'] + '.mp4')).unlink(missing_ok=True)
        self.thread = threading.Thread(target=self.loop, daemon=True, name='studio-cpu-media')
        self.thread.start()

    def close(self):
        self.closed.set()
        if self.thread: self.thread.join(timeout=5)
        # The loop retains its lease until it actually exits.

    def loop(self):
        try:
            while not self.closed.is_set():
                with self.store.connect() as db:
                    row = db.execute("SELECT id FROM renditions WHERE state='queued' ORDER BY created LIMIT 1").fetchone()
                if row: self.run(row['id'])
                else: self.closed.wait(.3)
        finally:
            self.lock.close()

    def run(self, identity):
        job = self.get(identity)
        request = job['request']
        destination = self.store.root / 'renditions' / (identity + '.mp4')
        destination.parent.mkdir(exist_ok=True)
        def cancelled(): return self.closed.is_set() or bool(self.get(identity)['cancel'])
        def update(progress):
            with self.store.connect() as db:
                db.execute("UPDATE renditions SET progress=?,updated=? WHERE id=? AND cancel=0", (progress, time.time(), identity))
        try:
            if cancelled(): raise RenderCancelled()
            with self.store.connect() as db:
                db.execute("UPDATE renditions SET state='encoding',message='Resizing and encoding on the CPU. Your original stays unchanged.',updated=? WHERE id=? AND cancel=0", (time.time(), identity))
            asset = self.store.asset(request['source_id'], job['project'])
            source = self.store.file(asset)
            with source.open('rb') as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() != request['source_sha256']:
                    raise ValueError('The source video changed after this request was queued.')
            info = encode_copy(source, destination, request, update, cancelled)
            if cancelled(): raise RenderCancelled()
            result = self.store.add_asset(job['project'], 'video', request['source_name'][:100] + ' · ' + request['preset'], destination.read_bytes(), '.mp4',
                {**info, 'origin': 'derived', 'rendition': identity, 'source_ids': [asset['id']], 'delivery': request})
            with self.store.connect() as db:
                db.execute("UPDATE renditions SET state=CASE WHEN cancel=1 THEN 'cancelled' ELSE 'completed' END,message=CASE WHEN cancel=1 THEN 'Stopped after the completed copy was saved. It remains in your project.' ELSE 'Delivery copy saved in your project.' END,progress=1,asset=?,updated=? WHERE id=?", (result['id'], time.time(), identity))
        except RenderCancelled:
            with self.store.connect() as db:
                db.execute("UPDATE renditions SET state=?,message='Encoding stopped. The original video is unchanged.',updated=? WHERE id=?", ('interrupted' if self.closed.is_set() else 'cancelled', time.time(), identity))
        except Exception as error:
            with self.store.connect() as db:
                db.execute("UPDATE renditions SET state='failed',message=?,updated=? WHERE id=?", (str(error) if isinstance(error, ValueError) else 'The local encoder could not complete this copy. Your original is unchanged.', time.time(), identity))
        finally:
            destination.unlink(missing_ok=True)
