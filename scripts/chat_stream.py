"""Relay real local deltas and structured calls; execution belongs to Studio."""
import json
from pathlib import Path
import sys
import time
import uuid

from cancellable_stream import CancellableStream, StreamCancelled, _atomic_json
from stream_protocol import StreamResponse


def progress(result, *, stopping=False):
    message = (
        'Reply stopped. The partial reply is kept.' if stopping
        else 'Preparing a project tool call.' if result.calls
        else 'Writing your reply.' if result.content
        else 'Reasoning locally, with space reserved for your answer.' if result.reasoning
        else 'Preparing your reply.'
    )
    print('STUDIO:' + json.dumps({
        'state': 'cancelling' if stopping else 'generating',
        'message': message, 'progress': {'text': result.content},
    }), flush=True)


def main(directory):
    request = json.loads((directory / 'writing-request.json').read_text())
    body = request['body'].copy()
    body.update(stream=True, stream_options={'include_usage': True})
    result = StreamResponse(bool(body.get('tools')))
    last = 0
    internal = bool(request.get('internal'))
    # Older callers remain usable but cannot request cooperative cancellation
    # until they provide the fresh nonce in their writing-request record.
    nonce = request.get('invocation_nonce') or uuid.uuid4().hex
    (directory / 'writing-result.json').unlink(missing_ok=True)
    try:
        with CancellableStream(directory, nonce=nonce, port=request['port'], body=body,
                               partial=lambda: result.content, internal=internal,
                               timeout=request.get('timeout', 600)) as response:
            for line in response:
                if not line.startswith(b'data:'):
                    continue
                raw = line[5:].strip()
                if raw == b'[DONE]':
                    break
                result.feed(json.loads(raw))
                if time.monotonic() - last > .4 and not internal:
                    progress(result)
                    last = time.monotonic()
            # Validate inside the context, so a malformed or truncated model
            # response never receives a successful transport acknowledgement.
            value = result.result()
    except StreamCancelled:
        if not internal:
            progress(result, stopping=True)
        return 130
    except ValueError as error:
        value = {'error': {'message':
            'The local reply was incomplete or malformed. No new tools were run in this round. ' + str(error)}}
    _atomic_json(directory / 'writing-result.json', {**value, 'invocation_nonce': nonce})
    return 0


if __name__ == '__main__':
    raise SystemExit(main(Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/job')))
