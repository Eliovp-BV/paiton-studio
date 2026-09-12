"""Thin runner inside the installed public runtime. No inference implementation."""
import json
from pathlib import Path
import time

def event(state, message, progress=None):
    print('STUDIO:' + json.dumps(dict(state=state, message=message, progress=progress)), flush=True)

request = json.loads(Path('/job/request.json').read_text())
from paiton_image.pipeline import load_pipeline, generate
started = time.monotonic()
event('loading', 'Loading the image tool. First use includes compilation.')
pipe = load_pipeline('paiton')
event('generating', 'Creating your image. The first step may compile locally.')
def callback(pipe, step, timestep, values):
    event('generating', 'Creating your image.', dict(value=step+1, maximum=4))
    return values
image = generate(pipe, request['prompt'], request['seed'], callback).images[0]
event('saving', 'Saving your image.')
image.save('/job/result.png')
Path('/job/result.json').write_text(json.dumps({'seconds': time.monotonic()-started}))
