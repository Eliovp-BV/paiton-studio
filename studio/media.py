import io
import json
import subprocess
import av
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 32_000_000

def image_info(content):
    try:
        with Image.open(io.BytesIO(content)) as img:
            if img.format not in ('PNG','JPEG'): raise ValueError('Choose a PNG or JPEG image.')
            if img.width*img.height>Image.MAX_IMAGE_PIXELS: raise ValueError('Choose an image smaller than 32 megapixels.')
            img.verify()
        with Image.open(io.BytesIO(content)) as img:
            img.load()
            return {'width':img.width,'height':img.height,'format':img.format}
    except (OSError,Image.DecompressionBombError) as error:
        raise ValueError('Choose a complete PNG or JPEG image within the size limit.') from error


def letterbox(source, destination, width, height):
    with Image.open(source) as img:
        img = ImageOps.exif_transpose(img).convert('RGB')
        size = img.size
        result = ImageOps.pad(img,(width,height),method=Image.Resampling.LANCZOS,color=(11,15,17),centering=(0.5,0.5))
        result.save(destination)
    return dict(method='letterbox',source_size=list(size),output_size=[width,height],resampler='Pillow LANCZOS',background='#0B0F11',orientation='EXIF transpose')


def video_info(path):
    with av.open(str(path)) as container:
        if not container.streams.video: raise ValueError('The video output is incomplete.')
        video=container.streams.video[0]
        if not video.duration or not video.time_base: raise ValueError('The video duration is unavailable.')
        duration=float(video.duration*video.time_base)
        if not 0<duration<=20: raise ValueError('The video duration is outside the supported profiles.')
        width,height=video.width,video.height
        if width*height>2048*2048: raise ValueError('The video dimensions are outside the supported profiles.')
        audio=bool(container.streams.audio)
        info=dict(width=width,height=height,duration=duration,audio=audio,codec=video.codec_context.name)
        if audio:
            stream=container.streams.audio[0]
            info.update(audio_channels=len(stream.codec_context.layout.channels),sample_rate=stream.codec_context.sample_rate)
        # Decode every stream before registering a successful result, not just its header.
        frames=0;audio_samples=0
        for packet in container.demux():
            for frame in packet.decode():
                if isinstance(frame,av.VideoFrame): frames+=1
                elif isinstance(frame,av.AudioFrame): audio_samples+=frame.samples
        if not frames or (audio and not audio_samples): raise ValueError('The media stream is incomplete.')
        info.update(decoded_frames=frames,audio_samples=audio_samples)
        return info
