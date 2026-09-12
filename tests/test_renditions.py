"""Real CPU media fixtures; these tests do not simulate or invoke AI inference."""
from fractions import Fraction
from array import array
import hashlib
import math

import av
from PIL import Image, ImageDraw
import pytest
from pydantic import ValidationError

from studio import renditions as media
from studio.renditions import PRESETS, RenditionInput, Renditions, encode_copy, reframe
from studio.store import Store


def make_clip(path, rate=Fraction(24), frames=12):
    """A short moving color pattern with a real, non-silent AAC test tone."""
    with av.open(str(path), 'w', format='mp4') as output:
        video = output.add_stream('libx264', rate=rate)
        video.width, video.height = 192, 108
        video.pix_fmt = 'yuv420p'
        video.codec_context.thread_count = 1
        audio = output.add_stream('aac', rate=32000)
        audio.layout = 'stereo'
        audio.codec_context.thread_count = 1
        for index in range(frames):
            image = Image.new('RGB', (192, 108), '#203040')
            ImageDraw.Draw(image).rectangle((index * 5, 10, index * 5 + 30, 85), fill='#ffd400')
            frame = av.VideoFrame.from_image(image)
            frame.pts, frame.time_base = index, 1 / rate
            for packet in video.encode(frame):
                output.mux(packet)
        for packet in video.encode():
            output.mux(packet)
        count = round(frames / float(rate) * 32000)
        signal = array('f', (.15 * math.sin(i * 2 * math.pi * 440 / 32000) for i in range(count)))
        frame = av.AudioFrame(format='fltp', layout='stereo', samples=count)
        for plane in frame.planes:
            plane.update(signal.tobytes())
        frame.sample_rate = 32000
        frame.pts, frame.time_base = 0, Fraction(1, 32000)
        for packet in audio.encode(frame):
            output.mux(packet)
        for packet in audio.encode():
            output.mux(packet)
    return path


def inspect_clip(path):
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        result = dict(width=stream.width, height=stream.height, rate=stream.average_rate,
                      duration=stream.duration * stream.time_base,
                      audio_streams=len(container.streams.audio), frames=[], samples=0)
        for packet in container.demux():
            for frame in packet.decode():
                if isinstance(frame, av.VideoFrame):
                    result['frames'].append(frame.pts * frame.time_base)
                else:
                    result['samples'] += frame.samples
        return result


def audio_packets(path):
    with av.open(str(path)) as container:
        return [bytes(packet) for packet in container.demux(container.streams.audio[0]) if packet.dts is not None]


@pytest.fixture
def saved_video(tmp_path):
    source = make_clip(tmp_path / 'fixture.mp4')
    store = Store(tmp_path / 'studio')
    project = store.create_project('CPU media fixture')['id']
    asset = store.add_asset(project, 'video', 'Test tone and color pattern', source.read_bytes(), '.mp4',
                            {'origin': 'test-fixture', 'fixture': True})
    return store, project, asset


@pytest.mark.parametrize('preset', list(PRESETS))
def test_actual_delivery_dimensions_timestamps_and_unchanged_aac(saved_video, preset):
    store, project, asset = saved_video
    source = store.file(asset)
    original = source.read_bytes()
    before = inspect_clip(source)
    copies = Renditions(store)
    job = copies.submit(project, RenditionInput(source_id=asset['id'], preset=preset))
    copies.run(job['id'])
    finished = copies.get(job['id'])
    assert finished['state'] == 'completed', finished['message']
    assert finished['progress'] == 1
    result_asset = store.asset(finished['asset'], project)
    result = inspect_clip(store.file(result_asset))
    assert (result['width'], result['height']) == (PRESETS[preset]['width'], PRESETS[preset]['height'])
    assert result['frames'] == before['frames']
    assert result['rate'] == before['rate'] == 24
    assert result['duration'] == before['duration']
    assert result['audio_streams'] == 1
    assert result['samples'] == before['samples'] > 0
    assert audio_packets(store.file(result_asset)) == audio_packets(source)
    assert source.read_bytes() == original
    assert result_asset['metadata']['origin'] == 'derived'
    assert result_asset['metadata']['source_ids'] == [asset['id']]
    assert result_asset['metadata']['delivery']['source_sha256'] == hashlib.sha256(original).hexdigest()
    assert copies.list(project)[0]['progress'] == 1
    assert not list((store.root / 'renditions').glob('*.mp4'))


def test_mute_removes_audio_without_changing_source(saved_video):
    store, project, asset = saved_video
    copies = Renditions(store)
    job = copies.submit(project, RenditionInput(source_id=asset['id'], preset='square', audio='mute'))
    copies.run(job['id'])
    result = copies.get(job['id'])
    assert result['state'] == 'completed', result['message']
    rendered = store.asset(result['asset'])
    assert inspect_clip(store.file(rendered))['audio_streams'] == 0
    assert rendered['metadata']['audio'] is False
    assert inspect_clip(store.file(asset))['audio_streams'] == 1


def test_fractional_source_framerate_is_preserved(tmp_path):
    source = make_clip(tmp_path / 'source.mp4', rate=Fraction(30000, 1001), frames=6)
    destination = tmp_path / 'output.mp4'
    encode_copy(source, destination, dict(preset='wide', fit='contain', focal_x=.5, audio='preserve'),
                lambda value: None, lambda: False)
    original, output = inspect_clip(source), inspect_clip(destination)
    assert output['rate'] == original['rate'] == Fraction(30000, 1001)
    assert output['frames'] == original['frames']
    # MP4 edit-list rounding can truncate the source's last frame by sub-ms time.
    assert abs(output['duration'] - original['duration']) < Fraction(1, 1000)


def test_fit_keeps_entire_picture_and_crop_respects_focal_position():
    source = Image.new('RGB', (300, 100), 'green')
    draw = ImageDraw.Draw(source)
    draw.rectangle((0, 0, 99, 99), fill='red')
    draw.rectangle((200, 0, 299, 99), fill='blue')
    original = source.tobytes()
    assert reframe(source, 100, 100, 'cover', 0).getpixel((50, 50)) == (255, 0, 0)
    assert reframe(source, 100, 100, 'cover', 1).getpixel((50, 50)) == (0, 0, 255)
    fitted = reframe(source, 100, 100, 'contain', .5)
    assert fitted.getpixel((50, 0)) == (20, 20, 21)
    assert fitted.getpixel((10, 50)) == (255, 0, 0)
    assert fitted.getpixel((90, 50)) == (0, 0, 255)
    assert source.tobytes() == original


def test_request_snapshots_and_rejects_foreign_or_nonvideo_assets(saved_video):
    store, project, asset = saved_video
    copies = Renditions(store)
    body = RenditionInput(source_id=asset['id'], focal_x=.2)
    submitted = copies.submit(project, body)
    body.focal_x = .9
    assert copies.get(submitted['id'])['request']['focal_x'] == .2
    other = store.create_project()['id']
    with pytest.raises(ValueError, match='this project'):
        copies.submit(other, RenditionInput(source_id=asset['id']))
    text = store.add_asset(project, 'text', 'Caption', b'Fixture', '.md', {})
    with pytest.raises(ValueError, match='saved project video'):
        copies.submit(project, RenditionInput(source_id=text['id']))
    with pytest.raises(ValidationError):
        RenditionInput(source_id=asset['id'], focal_x=float('nan'))


def test_changed_source_fails_before_encoding(saved_video):
    store, project, asset = saved_video
    copies = Renditions(store)
    job = copies.submit(project, RenditionInput(source_id=asset['id']))
    store.file(asset).write_bytes(b'replaced fixture')
    copies.run(job['id'])
    failed = copies.get(job['id'])
    assert failed['state'] == 'failed'
    assert 'changed after' in failed['message']
    assert failed['asset'] is None
    assert len(store.assets(project)) == 1


def test_queued_cancel_and_actual_encoding_cancel_preserve_original(saved_video, monkeypatch):
    store, project, asset = saved_video
    original = store.file(asset).read_bytes()
    copies = Renditions(store)
    queued = copies.submit(project, RenditionInput(source_id=asset['id']))
    assert copies.cancel(queued['id'])['state'] == 'cancelled'
    active = copies.submit(project, RenditionInput(source_id=asset['id']))
    original_reframe = media.reframe
    calls = []

    def cancel_after_first_frame(*args):
        image = original_reframe(*args)
        calls.append(True)
        assert copies.get(active['id'])['state'] == 'encoding'
        copies.cancel(active['id'])
        return image

    monkeypatch.setattr(media, 'reframe', cancel_after_first_frame)
    copies.run(active['id'])
    assert calls == [True]
    assert copies.get(active['id'])['state'] == 'cancelled'
    assert len(store.assets(project)) == 1
    assert store.file(asset).read_bytes() == original
    assert not list((store.root / 'renditions').glob('*.mp4'))
    monkeypatch.setattr(media, 'reframe', original_reframe)
    retry = copies.submit(project, RenditionInput(source_id=asset['id'], preset='square'))
    copies.run(retry['id'])
    assert retry['id'] != active['id']
    assert copies.get(retry['id'])['state'] == 'completed'
    assert copies.get(active['id'])['state'] == 'cancelled'


def test_restart_recovers_active_state_without_losing_queue(saved_video):
    store, project, asset = saved_video
    copies = Renditions(store)
    active = copies.submit(project, RenditionInput(source_id=asset['id']))
    queued = copies.submit(project, RenditionInput(source_id=asset['id'], preset='square'))
    cancelled = copies.submit(project, RenditionInput(source_id=asset['id']))
    copies.cancel(cancelled['id'])
    with store.connect() as db:
        db.execute("UPDATE renditions SET state='encoding',progress=.25 WHERE id=?", (active['id'],))
    temporary = store.root / 'renditions' / (active['id'] + '.mp4')
    temporary.parent.mkdir(exist_ok=True)
    temporary.write_bytes(b'Interrupted incomplete media fixture')
    restarted = Renditions(Store(store.root))
    # Prevent dispatch while exercising startup reconciliation deterministically.
    restarted.closed.set()
    restarted.start()
    restarted.close()
    assert restarted.get(active['id'])['state'] == 'interrupted'
    assert restarted.get(active['id'])['progress'] == .25
    assert restarted.get(queued['id'])['state'] == 'queued'
    assert restarted.get(queued['id'])['request']['preset'] == 'square'
    assert restarted.get(cancelled['id'])['state'] == 'cancelled'
    assert len(store.assets(project)) == 1
    assert not temporary.exists()


def test_queue_limit_and_low_disk_are_actionable(saved_video, monkeypatch):
    store, project, asset = saved_video
    copies = Renditions(store)
    for _ in range(10):
        copies.submit(project, RenditionInput(source_id=asset['id']))
    with pytest.raises(ValueError, match='Ten delivery copies'):
        copies.submit(project, RenditionInput(source_id=asset['id']))
    monkeypatch.setattr(media.shutil, 'disk_usage', lambda path: type('Disk', (), {'free': 100})())
    with pytest.raises(ValueError, match='512 MB'):
        copies.submit(project, RenditionInput(source_id=asset['id']))
