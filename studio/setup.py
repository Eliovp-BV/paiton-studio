"""Explicit, persistent package setup; inference remains offline and separately queued.

Only catalog package IDs enter this module from HTTP. Source URLs, destinations,
hashes and commands are supplied by reviewed adapters, never browser payloads.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from .chat_adapters import CHAT_PACKAGES
from .docker_local import LocalDocker, DockerLocalError
from .registry import PACKAGES, profile, hardware_compatibility
from .resources import Lease
from .runtime import ROOT, RuntimeFailure
from .store import atomic, safe_path, uid
from .telemetry import gpu_status

TERMINAL = {'completed', 'cancelled', 'failed', 'interrupted'}
QWEN_REPOSITORY = 'amd/Qwen3.8-27B-Quark-Qronos-INT4-W4A16'
QWEN_REVISION = '649ca9d47a7de5364c6fcccc0c1b4f6e542e15e2'
QWEN_CHECKPOINT_BYTES = 19893384832
QWEN_CHECKPOINT_SHA256 = '32190ba51af3e048f927b446f251a171e475cc91456a831e374709e74a8f0454'
QWEN_IMAGE = 'ghcr.io/eliovp/paiton-vllm-plugin@sha256:c56baf54aca1ad229829c1de26e8792806608e65ee9d06ee210b79cd49f70bc9'
DOWNLOAD_DOMAINS = ('huggingface.co', 'hf.co', 'github.com', 'githubusercontent.com', 'ghcr.io')


class SetupFailure(RuntimeError):
    pass


class SetupCancelled(SetupFailure):
    pass


class SetupInterrupted(SetupFailure):
    pass


def _trusted_url(url):
    parsed = urllib.parse.urlsplit(url)
    hostname = (parsed.hostname or '').lower()
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise SetupFailure('The package source must use a trusted HTTPS address.')
    if not any(hostname == name or hostname.endswith('.' + name) for name in DOWNLOAD_DOMAINS):
        raise SetupFailure('The package redirected to an unsupported download host.')
    return url


class TrustedRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return super().redirect_request(req, fp, code, msg, headers, _trusted_url(newurl))


class SetupManager:
    def __init__(self, store, runtime, config_path=None):
        self.store, self.runtime = store, runtime
        self.docker = getattr(runtime, 'docker', None) or LocalDocker()
        self.root, self.config = store.root, runtime.config
        self.config_path = Path(config_path) if config_path is not None else ROOT / 'config.local.json'
        self.lock = threading.RLock()
        self.closed = threading.Event()
        self.thread = None
        self.lease = None
        self.process = None
        self._needs_recovery = True
        self._snapshot_cache = None
        self._snapshot_at = 0
        self._opener = urllib.request.build_opener(TrustedRedirect())
        with store.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS setup_jobs(
                    id TEXT PRIMARY KEY, package TEXT NOT NULL, state TEXT NOT NULL,
                    message TEXT NOT NULL, completed_bytes INTEGER NOT NULL DEFAULT 0,
                    total_bytes INTEGER, cancel INTEGER NOT NULL DEFAULT 0,
                    created REAL NOT NULL, updated REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS setup_jobs_order ON setup_jobs(state,created);
            ''')

    def _catalog(self):
        from .setup_catalog import PACKAGES as catalog
        integrated = {package['id'] for package in PACKAGES if package['integrated']}
        return {identity: spec for identity, spec in catalog.items() if identity in integrated}

    def jobs(self):
        return self.store.rows('SELECT * FROM setup_jobs ORDER BY created DESC LIMIT 100')

    def job(self, identity):
        rows = self.store.rows('SELECT * FROM setup_jobs WHERE id=?', (identity,))
        if not rows:
            raise ValueError('Setup request not found.')
        return rows[0]

    @staticmethod
    def _identity(job):
        return job['id'] if isinstance(job, dict) else job

    def update(self, job, state, message, **details):
        identity = self._identity(job)
        allowed = {'completed_bytes', 'total_bytes'}
        if set(details) - allowed:
            raise ValueError('Unsupported setup progress field.')
        with self.store.connect() as db:
            db.execute('UPDATE setup_jobs SET state=?,message=?,updated=?' + ''.join(f',{key}=?' for key in details) + ' WHERE id=?',
                       (state, message, time.time(), *details.values(), identity))
        if state in TERMINAL:
            self._snapshot_at = 0

    def _system(self):
        linux = platform.system() == 'Linux' and platform.machine() in ('x86_64', 'amd64')
        client = bool(shutil.which('docker'))
        docker = False
        docker_root = None
        docker_message = None
        if client:
            try:
                result = self.runtime.command(['info', '--format', '{{json .DockerRootDir}}'], timeout=5)
                docker = result.returncode == 0
                if docker:
                    docker_root = json.loads(result.stdout)
            except (RuntimeFailure, ValueError) as error:
                if isinstance(error, RuntimeFailure):
                    docker_message = str(error)
        devices = Path('/dev/kfd').exists() and Path('/dev/dri').is_dir()
        access = devices and os.access('/dev/kfd', os.R_OK | os.W_OK) and os.access('/dev/dri', os.R_OK | os.X_OK)
        gpu = gpu_status()
        driver = bool(devices and access)
        checks = [
            dict(id='platform', label='Supported operating system', state='ready' if linux else 'missing', message='Linux x86-64' if linux else 'These packages require Linux x86-64; Windows packaging is not available yet.'),
            dict(id='docker', label='Docker', state='ready' if docker else 'missing', message='Docker is available.' if docker else docker_message or ('Start Docker and give the Studio host user access to its daemon.' if client else 'Install Docker Engine on the Studio host before downloading runtime packages.')),
            dict(id='driver', label='Radeon driver access', state='ready' if driver else 'missing', message='Radeon devices are accessible.' if driver else ('Give the Studio host user access to the Radeon devices, then restart Studio.' if devices else 'Install the supported Radeon/ROCm driver on the Studio host; /dev/kfd and /dev/dri are required.')),
            dict(id='gpu', label='Graphics card detection', state='ready' if gpu.get('supported') else 'missing', message=(str(gpu.get('name') or 'Radeon GPU') + ' · ' + str(gpu.get('architecture') or 'unknown architecture') + '. Model eligibility is checked for each tool below.') if gpu.get('supported') else gpu['message']),
        ]
        ready = linux and docker and driver and gpu.get('supported', False)
        docker_free = None
        if docker_root:
            try:
                docker_free = shutil.disk_usage(docker_root).free
            except OSError:
                pass
        return dict(docker=docker, driver=driver, supported_gpu=gpu.get('supported', False),
                    ready=bool(ready), can_download=bool(linux and docker), gpu=gpu, disk_free_bytes=shutil.disk_usage(self.root).free,
                    docker_disk_free_bytes=docker_free, checks=checks,
                    message='The host is ready for model setup.' if ready else next(c['message'] for c in checks if c['state'] != 'ready'))

    @staticmethod
    def _install_block(spec, system):
        if not system.get('can_download', system['ready']):
            return 'system_required', system['message']
        if spec.get('installer') == 'flux':
            eligibility = hardware_compatibility('flux', system.get('gpu', {}))
            if not system['ready'] or not eligibility['compatible']:
                return 'system_required', 'Image preparation needs a compatible GPU. ' + eligibility['reason']
        if system['disk_free_bytes'] < (spec.get('required_disk_bytes') or 0):
            return 'insufficient_disk', 'Free more space on the Studio host before downloading this package.'
        docker_free = system.get('docker_disk_free_bytes')
        if docker_free is not None and docker_free < spec.get('runtime_disk_bytes', 12 * 1024**3):
            return 'insufficient_disk', 'Docker storage needs more free space for the runtime package.'
        return None

    def _readiness(self, identity):
        package = next((item for item in PACKAGES if item['id'] == identity), None)
        if not package or not package['integrated'] or not package['profiles']:
            return False, 'This model does not yet have a supported Studio integration.'
        try:
            selected = package['profiles'][0]
            self.runtime.preflight({'profile': profile(selected['id'], selected['task'])})
            return True, 'Installed locally. The model loads when you create something.'
        except (RuntimeFailure, OSError, ValueError, KeyError) as error:
            return False, str(error) if isinstance(error, RuntimeFailure) else 'The required local model files are missing or incomplete.'

    def snapshot(self, force=False):
        # Probe results are shared across polling clients; job progress is always fresh.
        with self.lock:
            if force or self._snapshot_cache is None or time.monotonic() - self._snapshot_at > 5:
                system = self._system()
                readiness = {key: self._readiness(key) if system['docker'] else (False, system['message']) for key in self._catalog()}
                self._snapshot_cache = (system, readiness)
                self._snapshot_at = time.monotonic()
            system, readiness = self._snapshot_cache
            jobs = self.jobs()
            tools = []
            for identity, source in self._catalog().items():
                ready, message = readiness[identity]
                eligibility = hardware_compatibility(identity, system.get('gpu', {}))
                active = next((j for j in jobs if j['package'] == identity and j['state'] not in TERMINAL), None)
                last = next((j for j in jobs if j['package'] == identity), None)
                installer = source.get('installer', 'manual')
                supported_install = installer in ('qwen38', 'flux', 'h3', 'qwen-coder','gptoss','wan','fastwan','minicpm5-2b') and source.get('can_install', False)
                blocked = self._install_block(source, system)
                state = 'ready' if ready else 'setup_required'
                if not ready and not supported_install:
                    state, message = 'manual_setup', source.get('message', 'This package needs manual preparation.')
                if ready and not system['ready']:
                    state, message = 'system_required', system['message']
                elif blocked:
                    state, message = blocked
                elif not ready and not system['ready'] and supported_install:
                    message = 'You can download these files now. Generation will still need the supported Radeon driver and GPU.'
                elif not eligibility['compatible']:
                    state, message = 'incompatible', eligibility['reason']
                    if not ready and supported_install and not blocked:
                        message += ' You may download the files, but they cannot generate on this card.'
                if active:
                    state, message = 'installing', active['message']
                steps = []
                labels = source.get('steps', [])
                for index, label in enumerate(labels):
                    if isinstance(label, dict):
                        item = dict(label)
                    else:
                        item = {'id': str(index + 1), 'label': label}
                    # Runtime adapters report named phases; whole-job completion is the
                    # only universal evidence that every preparation step has finished.
                    item.setdefault('state', 'completed' if ready else 'pending')
                    steps.append(item)
                tools.append({**source, 'state': state, 'message': message, 'download_note': source.get('download_note', source.get('message')), 'steps': steps,
                              'compatibility': eligibility,
                              'files_ready': ready, 'generation_ready': ready and system['ready'] and eligibility['compatible'],
                              'can_install': bool(not blocked and supported_install and not ready and not active),
                              'job': last})
            return {'system': dict(system), 'tools': tools, 'jobs': jobs}

    def install(self, package):
        with self.lock:
            if package not in self._catalog():
                raise ValueError('Choose a supported local model package.')
            active = next((j for j in self.jobs() if j['package'] == package and j['state'] not in TERMINAL), None)
            if active:
                return active
            info = next(item for item in self.snapshot(force=True)['tools'] if item['id'] == package)
            if not info['can_install']:
                raise ValueError(info['message'])
            identity, now = uid(), time.time()
            with self.store.connect() as db:
                db.execute('INSERT INTO setup_jobs(id,package,state,message,created,updated) VALUES(?,?,?,?,?,?)',
                           (identity, package, 'queued', 'Download requested. Waiting for other package setup to finish.', now, now))
            return self.job(identity)

    def cancel(self, identity):
        with self.lock:
            job = self.job(identity)
            if job['state'] in TERMINAL:
                return job
            with self.store.connect() as db:
                db.execute('UPDATE setup_jobs SET cancel=1 WHERE id=?', (identity,))
            self.update(job, 'cancelled' if job['state'] == 'queued' else 'cancelling',
                        'Download cancelled. Verified files and partial downloads are kept for a later retry.' if job['state'] == 'queued' else 'Stopping this setup request. Completed files are kept.')
            return self.job(identity)

    def check_cancel(self, job):
        if self.closed.is_set():
            raise SetupInterrupted('Studio closed during setup. Choose Download again to resume verified partial files.')
        if job is not None and self.job(self._identity(job))['cancel']:
            raise SetupCancelled('Setup cancelled. Completed files and partial downloads are kept for retry.')

    def start(self):
        with self.lock:
            if self.thread and self.thread.is_alive():
                return
            self.lease = Lease(self.root / 'setup.lock')
            if not self.lease.acquire():
                raise RuntimeError('Another Studio controller is already preparing packages for this data directory.')
            self.closed.clear()
            # Setup adapters use an ownership label distinct from inference.
            try:
                from .setup_media import recover_setup
                self._needs_recovery = recover_setup(self) is not True
            except ImportError:
                pass
            except (SetupFailure, RuntimeFailure):
                # Missing Docker must not prevent the first-run guide opening.
                # Retry ownership recovery before any later setup execution.
                pass
            with self.store.connect() as db:
                db.execute("UPDATE setup_jobs SET state='interrupted',message=?,updated=? WHERE state NOT IN ('queued','completed','cancelled','failed','interrupted')",
                           ('Studio closed during setup. Choose Download again to resume verified partial files.', time.time()))
            self.thread = threading.Thread(target=self._loop, name='studio-setup', daemon=True)
            self.thread.start()

    def close(self):
        self.closed.set()
        if self.thread:
            self.thread.join(timeout=20)
        # The worker retains its lease if an operation has not yet returned.
        # Its finally block releases ownership only after actual completion.

    def _loop(self):
        try:
            while not self.closed.wait(.3):
                jobs = self.store.rows("SELECT * FROM setup_jobs WHERE state='queued' AND cancel=0 ORDER BY created LIMIT 1")
                if not jobs:
                    continue
                job = jobs[0]
                try:
                    self.check_cancel(job)
                    spec = self._catalog()[job['package']]
                    system = self._system()
                    blocked = self._install_block(spec, system)
                    if blocked:
                        raise SetupFailure(blocked[1])
                    if self._needs_recovery:
                        from .setup_media import recover_setup
                        if recover_setup(self) is not True:
                            raise SetupFailure('Previous package preparation could not be checked. Restore Docker access, then retry setup.')
                        self._needs_recovery = False
                    if spec['installer'] in ('gptoss','wan','fastwan','minicpm5-2b'):
                        from .setup_alternatives import gptoss,wan,minicpm5
                        {'gptoss':gptoss,'wan':wan,'fastwan':wan,'minicpm5-2b':minicpm5}[spec['installer']](self,job)
                    elif spec['installer'] == 'qwen38':
                        self._qwen38(job)
                    elif spec['installer'] in ('flux', 'h3', 'qwen-coder'):
                        from .setup_media import install_media
                        install_media(self, job)
                    else:
                        raise SetupFailure('This package needs a supported preparation adapter before it can be installed.')
                    self.check_cancel(job)
                    self.update(job, 'completed', 'Installed locally. The model will load when you create something.')
                except SetupCancelled as error:
                    self.update(job, 'cancelled', str(error))
                except SetupInterrupted as error:
                    self.update(job, 'interrupted', str(error))
                except Exception as error:
                    message = str(error) if isinstance(error, (RuntimeError, ValueError)) else 'Setup could not finish. Check the host network and free space, then choose Download again to retry.'
                    self.update(job, 'failed', message)
        finally:
            if self.lease:
                self.lease.close()

    def run(self, command, job, timeout=3600):
        """Run only reviewed adapter argv; stop the exact child process on cancel."""
        if job is not None:
            self.check_cancel(job)
        output = bytearray()
        try:
            if not isinstance(command, (list, tuple)) or not command or command[0] != 'docker':
                raise SetupFailure('This setup command is outside the reviewed package contract.')
            command, environment = self.docker.invocation(command[1:])
            process = subprocess.Popen(command, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        except DockerLocalError as error:
            raise SetupFailure(str(error)) from error
        except OSError as error:
            raise SetupFailure('A required host setup command is unavailable.') from error
        self.process = process
        def drain():
            for chunk in iter(lambda: process.stdout.read(65536), b''):
                output.extend(chunk)
                if len(output) > 1024 * 1024:
                    del output[:len(output) - 1024 * 1024]
        reader = threading.Thread(target=drain, daemon=True)
        reader.start()
        deadline = time.monotonic() + timeout
        try:
            while process.poll() is None:
                if job is not None:
                    self.check_cancel(job)
                if time.monotonic() > deadline:
                    raise SetupFailure('The package operation timed out. Completed downloads are kept; retry when the host is ready.')
                if job is None:
                    time.sleep(.15)
                else:
                    self.closed.wait(.15)
            if job is not None:
                self.check_cancel(job)
            reader.join(timeout=3)
            result = subprocess.CompletedProcess(command, process.returncode, output.decode(errors='replace'), '')
            if result.returncode and job is not None:
                # Raw tool output can contain local paths and remote response details.
                raise SetupFailure('The package command failed. Check Docker, network access and free space, then retry setup.')
            return result
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
            reader.join(timeout=3)
            self.process = None

    def _open(self, url, headers=None):
        return self._opener.open(urllib.request.Request(_trusted_url(url), headers={'User-Agent': 'Paiton-Studio-Setup/1', 'Accept-Encoding': 'identity', **(headers or {})}), timeout=10)

    def read_json(self, url, job, limit=4 * 1024 * 1024):
        self.check_cancel(job)
        with self._open(url) as response:
            data = response.read(limit + 1)
        self.check_cancel(job)
        if len(data) > limit:
            raise SetupFailure('The package manifest exceeded its supported size.')
        try:
            value = json.loads(data)
        except (ValueError, UnicodeError) as error:
            raise SetupFailure('The package source returned an invalid manifest.') from error
        if not isinstance(value, dict):
            raise SetupFailure('The package source returned an invalid manifest.')
        return value

    def _digest(self, path, size, algorithm, job):
        digest = hashlib.sha256() if algorithm == 'sha256' else hashlib.sha1()
        if algorithm == 'git-sha1':
            digest.update(f'blob {size}\0'.encode())
        with path.open('rb') as stream:
            while chunk := stream.read(1024 * 1024):
                self.check_cancel(job)
                digest.update(chunk)
        return digest.hexdigest()

    def download(self, url, destination, size, sha256, job):
        if isinstance(sha256, str) and sha256.startswith('git:'):
            return self._download(url, destination, size, sha256[4:], 'git-sha1', job)
        return self._download(url, destination, size, sha256, 'sha256', job)

    def _download(self, url, destination, size, expected, algorithm, job):
        self.check_cancel(job)
        _trusted_url(url)
        destination = Path(destination)
        if not destination.is_absolute():
            destination = self.root / destination
        destination = safe_path(self.root, str(destination.relative_to(self.root)))
        if not isinstance(size, int) or size < 0 or not re.fullmatch(r'[0-9a-f]{64}' if algorithm == 'sha256' else r'[0-9a-f]{40}', expected):
            raise SetupFailure('The package file is missing a valid size or checksum.')
        destination.parent.mkdir(parents=True, exist_ok=True)
        part = safe_path(self.root, 'model-downloads/' + hashlib.sha256(str(destination.relative_to(self.root)).encode()).hexdigest() + '.part')
        part.parent.mkdir(parents=True, exist_ok=True)
        base = self.job(self._identity(job))['completed_bytes']
        if destination.is_file() and destination.stat().st_size == size:
            self.update(job, 'verifying', 'Checking a previously downloaded package file.')
            if self._digest(destination, size, algorithm, job) == expected:
                self.update(job, 'downloading', 'Reusing a verified local package file.', completed_bytes=base + size)
                return destination
        offset = part.stat().st_size if part.is_file() else 0
        if offset > size:
            part.unlink()
            offset = 0
        self.update(job, 'downloading', 'Downloading ' + destination.name + '.', completed_bytes=base + offset)
        if offset < size:
            headers = {'Range': f'bytes={offset}-'} if offset else {}
            with self._open(url, headers) as response:
                status = response.getcode()
                if status == 206:
                    match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', response.headers.get('Content-Range', ''))
                    if not match or tuple(map(int, match.groups())) != (offset, size - 1, size):
                        raise SetupFailure('The source returned an invalid resume range. Retry the download later.')
                elif status == 200:
                    offset = 0  # Range ignored: restart instead of appending duplicate bytes.
                else:
                    raise SetupFailure('The package source did not return a complete file.')
                length = response.headers.get('Content-Length')
                if length is not None and (not length.isdigit() or int(length) != size - offset):
                    raise SetupFailure('The package download size does not match the pinned release.')
                if response.headers.get('Content-Encoding', 'identity') != 'identity':
                    raise SetupFailure('The source returned an unsupported transfer encoding.')
                flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | (os.O_APPEND if offset else os.O_TRUNC)
                with os.fdopen(os.open(part, flags, 0o600), 'wb') as stream:
                    last_progress = 0
                    while True:
                        self.check_cancel(job)
                        chunk = response.read(min(1024 * 1024, size - offset + 1))
                        if not chunk:
                            break
                        if offset + len(chunk) > size:
                            raise SetupFailure('The package source sent more bytes than the pinned file size.')
                        stream.write(chunk)
                        offset += len(chunk)
                        if time.monotonic() - last_progress >= .3:
                            self.update(job, 'downloading', 'Downloading ' + destination.name + '.', completed_bytes=base + offset)
                            last_progress = time.monotonic()
                    stream.flush()
                    os.fsync(stream.fileno())
        if not part.is_file() and size == 0:
            atomic(part, b'')
        if not part.is_file() or part.stat().st_size != size:
            raise SetupFailure('The download stopped early. Choose Download again to resume the partial file.')
        self.update(job, 'verifying', 'Verifying ' + destination.name + '.', completed_bytes=base + size)
        if self._digest(part, size, algorithm, job) != expected:
            part.unlink()
            self.update(job, 'verifying', 'Checksum failed; the incomplete file was discarded.', completed_bytes=base)
            raise SetupFailure('A downloaded file failed its checksum. Choose Download again to fetch a clean copy.')
        self.check_cancel(job)
        os.replace(part, destination)
        return destination

    def configure(self, updates, job):
        """Only after verification: merge Studio's own config without replacing keys."""
        self.check_cancel(job)
        with self.lock:
            current = dict(self.config)
            if self.config_path.exists():
                try:
                    disk_config = json.loads(self.config_path.read_text())
                except ValueError as error:
                    raise SetupFailure('Studio configuration is invalid. Repair it before applying the installed package.') from error
                if not isinstance(disk_config, dict):
                    raise SetupFailure('Studio configuration must contain an object.')
                current.update(disk_config)
            self.update(job, 'configuring', 'Registering the verified local package.')
            atomic(self.config_path, (json.dumps({**current, **updates}, indent=2) + '\n').encode())
            self.config.update(updates)
            self._snapshot_at = 0

    def _qwen38(self, job):
        self.update(job, 'downloading_runtime', 'Downloading the pinned writing runtime. Docker transfer size depends on cached layers.', total_bytes=None)
        self.run(['docker', 'pull', QWEN_IMAGE], job, timeout=3600)
        info = self.read_json(f'https://huggingface.co/api/models/{QWEN_REPOSITORY}/revision/{QWEN_REVISION}?blobs=true', job)
        if info.get('sha') != QWEN_REVISION:
            raise SetupFailure('The model manifest does not match the pinned source revision.')
        siblings = {item['rfilename']: item for item in info.get('siblings', []) if isinstance(item, dict) and isinstance(item.get('rfilename'), str)}
        files = []
        for name in CHAT_PACKAGES['qwen38']['runtime_files']:
            source = siblings.get(name, {})
            lfs = source.get('lfs') or {}
            size = source.get('size', lfs.get('size'))
            digest = lfs.get('sha256') or source.get('blobId')
            algorithm = 'sha256' if lfs else 'git-sha1'
            if not isinstance(size, int) or size < 0 or not isinstance(digest, str):
                raise SetupFailure('The pinned model manifest is missing file verification information.')
            if name == 'model.safetensors':
                if size != QWEN_CHECKPOINT_BYTES or digest != QWEN_CHECKPOINT_SHA256 or algorithm != 'sha256':
                    raise SetupFailure('The model checkpoint does not match the checksum published by Paiton.')
            elif size > 128 * 1024 * 1024:
                raise SetupFailure('A model support file exceeds the supported manifest limit.')
            files.append(dict(name=name, size=size, checksum=digest, algorithm=algorithm))
        total = sum(item['size'] for item in files)
        self.update(job, 'downloading', 'Downloading the pinned model and tokenizer files.', total_bytes=total, completed_bytes=0)
        directory = safe_path(self.root, f'model-packages/qwen38/{QWEN_REVISION}')
        for item in files:
            url = f'https://huggingface.co/{QWEN_REPOSITORY}/resolve/{QWEN_REVISION}/{item["name"]}'
            self._download(url, directory / item['name'], item['size'], item['checksum'], item['algorithm'], job)
        atomic(directory / 'studio-download.json', json.dumps({'repository': QWEN_REPOSITORY, 'revision': QWEN_REVISION, 'files': files}, indent=2).encode())
        self.configure({'qwen38_image': QWEN_IMAGE, 'qwen38_model_dir': str(directory)}, job)
