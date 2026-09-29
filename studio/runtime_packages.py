"""Choose reviewed runtime versions without launching containers or model code."""
import json
import re
import time

from .runtime import RuntimeFailure
from .store import atomic, uid


REPOSITORY = 'ghcr.io/eliovp/paiton-vllm-plugin'
IMAGE_ID = re.compile(r'sha256:[0-9a-f]{64}\Z')
REMOTE = re.compile(re.escape(REPOSITORY) + r'(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[0-9a-f]{64})\Z')
TERMINAL = {'completed', 'cancelled', 'failed', 'interrupted'}
# Each chat's conversation memory setting selects a mode on the current image;
# saved requests can retain an older pinned image. Settings cannot change either.
CONTRACT_PINNED = {'qwen38-mxfp4': [('unified', 'Standard, 64K and 200K conversations · W3A4 / MXFP4 release')]}
PINNED_MESSAGE = ('This model’s conversation memory setting chooses a mode on its pinned release image. '
                  'Models installs one runtime for both modes; saved requests retain their original pins. '
                  'Other versions cannot be connected here.')


def _remote(reference):
    return isinstance(reference, str) and REMOTE.fullmatch(reference) is not None


def _image_id(value):
    return isinstance(value, str) and IMAGE_ID.fullmatch(value) is not None


def _matches(image, release):
    """Names and OCI labels never establish model or adapter compatibility."""
    expected = release.get('image_id')
    if _image_id(expected) and image.get('Id') == expected:
        return True
    reference = release.get('reference', '')
    digest = release.get('digest')
    if isinstance(digest, str) and digest.startswith(REPOSITORY + '@'):
        digest = digest.split('@', 1)[1]
    if not digest and reference.startswith(REPOSITORY + '@'):
        digest = reference.split('@', 1)[1]
    return bool(_image_id(digest) and (
        image.get('Id') == digest or REPOSITORY + '@' + digest in (image.get('RepoDigests') or [])))


class RuntimePackages:
    def __init__(self, setup):
        self.setup, self.store, self.runtime = setup, setup.store, setup.runtime
        with self.store.connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS runtime_package_requests(
                job TEXT PRIMARY KEY REFERENCES setup_jobs(id), reference TEXT NOT NULL)''')

    def _catalog(self):
        return {key: value for key, value in self.setup._catalog().items() if value.get('image_key')}

    def _spec(self, package):
        if not isinstance(package, str) or package not in self._catalog():
            raise ValueError('Choose a supported model before choosing its runtime package.')
        return self._catalog()[package]

    def _releases(self, package, spec):
        # Some catalog images are build inputs, not runnable Studio packages.
        if package in CONTRACT_PINNED:
            from .qwen_mxfp4 import IMAGE
            images = {'unified': IMAGE}
            return [{'reference': images[mode], 'label': label} for mode, label in CONTRACT_PINNED[package]]
        if 'runtime_images' in spec:
            return [dict(item) if isinstance(item, dict) else {'reference': item}
                    for item in spec['runtime_images']]
        if package == 'h3':
            return []
        if package in ('wan', 'fastwan'):
            from .alternative_models import WAN_IMAGE_ID
            result = [{'reference': WAN_IMAGE_ID, 'image_id': WAN_IMAGE_ID, 'label': 'Qualified local runtime'}]
            verified = self.runtime.config.get('wan_verified_image_id')
            if _image_id(verified) and self.runtime.config.get('wan_package_revision') == '043c10768a3dab586d55e1abb20a35b2bd2820ba':
                result.append({'reference': verified, 'image_id': verified, 'label': 'Verified local assembly'})
            return result
        reference = spec.get('image')
        return [{'reference': reference, 'label': 'Qualified release'}] if _remote(reference) else []

    def _inspect(self, references):
        references = list(dict.fromkeys(reference for reference in references if isinstance(reference, str) and reference))
        if not references:
            return []
        result = self.runtime.command(['image', 'inspect', '--', *references], timeout=15)
        try:
            images = json.loads(result.stdout or '[]')
        except (ValueError, TypeError):
            images = []
        if not isinstance(images, list):
            return []
        return [item for item in images if isinstance(item, dict) and _image_id(item.get('Id'))]

    @staticmethod
    def _details(image):
        if not image:
            return {'image_id': None, 'digests': [], 'tags': [], 'size_bytes': None}
        return {'image_id': image['Id'],
                'digests': sorted(item for item in (image.get('RepoDigests') or []) if _remote(item) and '@' in item),
                'tags': sorted(item for item in (image.get('RepoTags') or []) if _remote(item)),
                'size_bytes': image.get('Size') if type(image.get('Size')) is int else None}

    def _blocked(self, db, package, spec, own_job=None):
        setup_jobs = db.execute("SELECT id,state FROM setup_jobs WHERE state NOT IN ('completed','cancelled','failed','interrupted')").fetchall()
        if any(row['id'] != own_job and not (own_job and row['state'] == 'queued') for row in setup_jobs):
            return 'Finish or cancel package setup before switching runtime versions.'
        related = {key for key, value in self._catalog().items() if value['image_key'] == spec['image_key']}
        jobs = db.execute("SELECT request FROM jobs WHERE state NOT IN ('completed','cancelled','failed')").fetchall()
        for row in jobs:
            try:
                request = json.loads(row['request'])
            except (ValueError, TypeError):
                return 'An unfinished creation request needs recovery before switching packages.'
            if not isinstance(request, dict) or not isinstance(request.get('profile'), dict):
                continue
            if request['profile'].get('package') in related:
                return 'Finish or cancel this model’s queued and running creations before switching runtime versions.'
        return None

    def snapshot(self):
        with self.setup.lock:
            catalog = self._catalog()
            releases = {key: self._releases(key, spec) for key, spec in catalog.items()}
            references = []
            for key, spec in catalog.items():
                references.append(self.runtime.config.get(spec['image_key']))
                for release in releases[key]:
                    references += [release.get('reference'), release.get('image_id')]
            available, message = True, None
            try:
                listed = self.runtime.command(['image', 'ls', '--no-trunc', '--quiet', REPOSITORY], timeout=10)
                if listed.returncode:
                    available, message = False, 'Local Docker is unavailable. Restore Docker access to choose runtime versions.'
                else:
                    references += [value for value in listed.stdout.split() if _image_id(value)][:256]
                images = self._inspect(references)
            except RuntimeFailure as error:
                available, message, images = False, str(error), []
            by_id = {image['Id']: image for image in images}
            selections = self.runtime.config.get('runtime_package_selections', {})
            if not isinstance(selections, dict):
                selections = {}
            packages = []
            with self.store.connect() as db:
                for key, spec in catalog.items():
                    configured = self.runtime.config.get(spec['image_key'])
                    if not isinstance(configured, str):
                        configured = None
                    current_image = by_id.get(configured) or next((image for image in images
                        if configured and configured in (image.get('RepoTags') or []) + (image.get('RepoDigests') or [])), None)
                    saved = selections.get(spec['image_key'], {})
                    if not isinstance(saved, dict):
                        saved = {}
                    reference = saved.get('reference') if saved.get('image_id') == configured else configured
                    current = {'reference': reference, 'configured': configured, **self._details(current_image),
                               'compatible': bool(current_image and any(_matches(current_image, release) for release in releases[key]))}
                    versions, seen = [], set()
                    for release in releases[key]:
                        image = next((image for image in images if _matches(image, release)), None)
                        identity = image['Id'] if image else release.get('image_id') or release.get('reference')
                        if identity in seen:
                            continue
                        seen.add(identity)
                        details = self._details(image)
                        versions.append({'reference': release.get('reference'),
                            'label': release.get('label') or release.get('reference'),
                            'channel': release.get('channel', 'release'), **details,
                            'installed': image is not None,
                            'selected': bool(image and current_image and image['Id'] == current_image['Id']),
                            'can_pull': _remote(release.get('reference'))})
                    blocked = self._blocked(db, key, spec)
                    pinned = key in CONTRACT_PINNED
                    components = []
                    if key == 'qwen38-mxfp4':
                        from .qwen_mxfp4 import optional_status
                        components = [optional_status(self.runtime)]
                        component_job = next((job for job in self.setup.jobs()
                            if job['package'] == key and job.get('component') == 'w3a4'), None)
                        components[0]['job'] = component_job
                        if component_job and component_job['state'] not in TERMINAL:
                            components[0]['state'] = 'installing'
                    packages.append({'id': key, 'model': spec.get('model', key), 'current': current,
                                     'optional_components': components,
                                     'versions': versions, 'blocked_reason': blocked, 'pinned': pinned,
                                     'can_switch': available and not blocked and not pinned and any(item['installed'] for item in versions),
                                     'can_pull': available and not blocked and not pinned and bool(releases[key]),
                                     'message': 'This runtime is assembled locally. Use creation-tool setup to prepare it.' if key == 'h3' else
                                                PINNED_MESSAGE if pinned else
                                                'Only versions approved for this model’s Studio adapter can be connected.'})
            return {'repository': REPOSITORY, 'available': available, 'message': message, 'packages': packages}

    def _reference(self, package, reference, pulling=False):
        spec = self._spec(package)
        if package in CONTRACT_PINNED:
            raise ValueError(PINNED_MESSAGE)
        releases = self._releases(package, spec)
        if not releases:
            raise ValueError('This model needs its creation-tool setup recipe; its build input is not a runnable package.')
        reviewed_local = any(reference == release.get('reference') for release in releases)
        if not isinstance(reference, str) or not (_remote(reference) or not pulling and (_image_id(reference) or reviewed_local)):
            raise ValueError('Choose an installed approved version or a full ghcr.io/eliovp/paiton-vllm-plugin tag or digest.')
        return spec, releases

    def select(self, package, reference, own_job=None):
        with self.setup.lock:
            spec, releases = self._reference(package, reference)
            images = self._inspect([reference])
            if len(images) != 1:
                raise ValueError('That runtime is not installed locally. Download it before connecting it.')
            image = images[0]
            if not any(_matches(image, release) for release in releases):
                raise ValueError('This image is not an approved runtime for the selected model. The current package was kept.')
            with self.store.connect() as db:
                # Serialize against every job submission, including background
                # workflows, without needing each caller to know this manager.
                db.execute('BEGIN IMMEDIATE')
                blocked = self._blocked(db, package, spec, own_job)
                if blocked:
                    raise ValueError(blocked)
                if own_job:
                    self.setup.check_cancel(own_job)
                current = dict(self.runtime.config)
                if self.setup.config_path.exists():
                    try:
                        disk = json.loads(self.setup.config_path.read_text())
                    except (ValueError, OSError) as error:
                        raise ValueError('Studio configuration could not be read. Repair it before switching packages.') from error
                    if not isinstance(disk, dict):
                        raise ValueError('Studio configuration must contain an object.')
                    current.update(disk)
                saved = current.get('runtime_package_selections', {})
                if not isinstance(saved, dict):
                    saved = {}
                selection = {'reference': reference, **self._details(image), 'selected_at': time.time()}
                updates = {spec['image_key']: image['Id'],
                           'runtime_package_selections': {**saved, spec['image_key']: selection}}
                atomic(self.setup.config_path, (json.dumps({**current, **updates}, indent=2) + '\n').encode())
                self.runtime.config.update(updates)
                self.setup._snapshot_at = 0
            return {'package': package, 'current': {'configured': image['Id'], 'compatible': True, **selection}}

    def pull(self, package, reference):
        with self.setup.lock:
            spec, _ = self._reference(package, reference, pulling=True)
            system = self.setup._system()
            blocked = self.install_block(spec, system)
            if blocked:
                raise ValueError(blocked[1])
            with self.store.connect() as db:
                db.execute('BEGIN IMMEDIATE')
                existing = db.execute('''SELECT s.id FROM setup_jobs s JOIN runtime_package_requests r ON r.job=s.id
                    WHERE s.package=? AND r.reference=? AND s.state NOT IN ('completed','cancelled','failed','interrupted')''',
                    (package, reference)).fetchone()
                if existing:
                    return self.setup.job(existing['id'])
                blocked = self._blocked(db, package, spec)
                if blocked:
                    raise ValueError(blocked)
                identity, now = uid(), time.time()
                db.execute('INSERT INTO setup_jobs(id,package,state,message,created,updated) VALUES(?,?,?,?,?,?)',
                           (identity, package, 'queued', 'Runtime download requested. The current package stays connected until verification finishes.', now, now))
                db.execute('INSERT INTO runtime_package_requests(job,reference) VALUES(?,?)', (identity, reference))
            return self.setup.job(identity)

    @staticmethod
    def install_block(spec, system):
        if not system.get('can_download', system.get('ready')):
            return 'system_required', system['message']
        free = system.get('docker_disk_free_bytes')
        if free is not None and free < spec.get('runtime_disk_bytes', 12 * 1024**3):
            return 'insufficient_disk', 'Docker storage needs more free space for this runtime package.'
        return None

    def handles(self, job):
        return bool(self.store.rows('SELECT reference FROM runtime_package_requests WHERE job=?', (job['id'],)))

    def run(self, job):
        self.setup.check_cancel(job)
        rows = self.store.rows('SELECT reference FROM runtime_package_requests WHERE job=?', (job['id'],))
        if not rows:
            raise ValueError('Runtime download request is missing.')
        reference = rows[0]['reference']
        self._reference(job['package'], reference, pulling=True)
        self.setup.update(job, 'downloading_runtime', 'Downloading the selected runtime. Existing model weights are reused.', total_bytes=None)
        self.setup.run(['docker', 'pull', reference], job, timeout=7200)
        self.setup.check_cancel(job)
        self.setup.update(job, 'verifying', 'Verifying the downloaded runtime against this model’s approved versions.')
        self.select(job['package'], reference, own_job=job['id'])
