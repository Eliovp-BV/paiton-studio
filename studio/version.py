"""Studio's version and build identity from one source of truth: the VERSION file."""
import functools
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD_INFO = Path(__file__).with_name('build_info.json')


def version(root=ROOT):
    try:
        return (root / 'VERSION').read_text(encoding='utf-8').strip() or 'unknown'
    except OSError:
        return 'unknown'


@functools.lru_cache(maxsize=None)
def git_sha(root=ROOT):
    """This checkout's revision, read once per process rather than per request."""
    # Only this checkout's repository counts; a ZIP extracted inside another
    # repository must not report that repository's revision.
    if not (root / '.git').exists():
        return 'unknown'
    try:
        result = subprocess.run(['git', '-C', str(root), 'rev-parse', '--short', 'HEAD'],
                                capture_output=True, text=True, timeout=3, check=True)
    except (OSError, subprocess.SubprocessError):
        return 'unknown'
    return result.stdout.strip() or 'unknown'


def build_record(build_info=BUILD_INFO):
    """What the web build (or the source packaging) recorded; None when there is no record."""
    try:
        recorded = json.loads(Path(build_info).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    if not isinstance(recorded, dict):
        return None
    built_at = recorded.get('built_at')
    return dict(git_sha=str(recorded.get('git_sha') or '').strip() or 'unknown',
                built_at=str(built_at) if built_at else None)


def version_info(root=ROOT, build_info=BUILD_INFO):
    """A checkout reports its own git revision; a ZIP install reports the revision recorded when it was packaged."""
    build = build_record(build_info)
    sha = git_sha(root) if (root / '.git').exists() else (build or {}).get('git_sha') or 'unknown'
    info = dict(version=version(root), git_sha=sha)
    if build:
        info['build'] = build
    return info


def label(info=None):
    info = info or version_info()
    return f"Studio {info['version']} ({info['git_sha']})"
