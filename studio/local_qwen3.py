"""Validation for the explicit local, write-only dense Qwen package.

The image's reviewed contract verifies its wheel, artifact and runtime ABI.
Checkpoint hashes are cached against file identity and timestamps, so Settings
polling and queued execution use the same validation without repeated reads.
"""
import hashlib
import json
from pathlib import Path
import re
import threading
import uuid

REPOSITORY = 'Qwen/Qwen3-4B-Instruct-2507'
REVISION = 'cdbee75f17c01a7cc42f958dc650907174af0554'
BASE_IMAGE_ID = 'sha256:fb47f4ab6073da943e553849985c81326e33b425e1017f97f3f79fad09586a8e'
# Set only after real qualification and the final local package build. The
# existing qualification-in-progress image is intentionally not accepted here.
QUALIFIED_IMAGE_ID = None

PACKAGE_PROBE = """import json,sys
sys.path.insert(0,'/opt/paiton/dense-qwen')
from contract import installed_check
package,lock,binary=installed_check()
print(json.dumps({'package':package,'checkpoint':lock}))
"""


class LocalPackageError(ValueError):
    pass


def file_digest(path, algorithm):
    if algorithm == 'sha256':
        hasher = hashlib.sha256()
    elif algorithm == 'git-blob-sha1':
        hasher = hashlib.sha1()
        hasher.update(b'blob '+str(path.stat().st_size).encode()+b'\0')
    else:
        raise LocalPackageError('The local writing checkpoint uses an unsupported integrity format.')
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(8*1024**2), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


class LocalQwen3Validator:
    def __init__(self):
        self.lock = threading.RLock()
        self.images = {}
        self.sources = {}

    @staticmethod
    def _cleanup_probe(command, owner, name, nonce):
        inspected = command(['inspect','--type','container',name],timeout=5)
        if inspected.returncode:
            if 'no such object' in inspected.stderr.lower() or 'no such container' in inspected.stderr.lower():
                return
            raise LocalPackageError('Could not confirm cleanup of the local package integrity check.')
        try:
            containers = json.loads(inspected.stdout)
            container = containers[0]
            labels = container['Config']['Labels']
            if len(containers) != 1 or container['Name'] != '/'+name or labels.get('dev.paiton.studio.owner') != owner or labels.get('dev.paiton.studio.probe') != nonce:
                raise ValueError('probe ownership differs')
            identity = container['Id']
            if not isinstance(identity,str) or not re.fullmatch('[0-9a-f]{64}',identity):
                raise ValueError('invalid container identity')
        except (KeyError,IndexError,TypeError,ValueError) as error:
            raise LocalPackageError('The package integrity check container ownership could not be verified; it was not stopped.') from error
        removed = command(['rm','--force',identity],timeout=5)
        if removed.returncode and not ('no such object' in removed.stderr.lower() or 'no such container' in removed.stderr.lower()):
            raise LocalPackageError('Could not remove the owned package integrity check container.')

    def _metadata(self, command, owner, image):
        if image in self.images:
            return self.images[image]
        nonce = uuid.uuid4().hex
        name = 'paiton-studio-package-check-'+nonce
        try:
            result = command(['run','--rm','--pull=never','--network','none','--read-only',
                '--name',name,'--label','dev.paiton.studio.owner='+owner,
                '--label','dev.paiton.studio.probe='+nonce,'--entrypoint','python3',image,'-c',PACKAGE_PROBE])
        finally:
            self._cleanup_probe(command,owner,name,nonce)
        if result.returncode:
            raise LocalPackageError('The local short-draft package failed its runtime and artifact integrity checks.')
        try:
            data = json.loads(result.stdout)
            package, checkpoint = data['package'], data['checkpoint']
            if (
                package['status'] != 'hardware-qualified'
                or package.get('qualified_tasks') != ['write']
                or package.get('qualified_roles') != ['write']
                or not package.get('hardware_evidence')
                or package['model_repository'] != REPOSITORY
                or package['model_revision'] != REVISION
                or checkpoint['repository'] != REPOSITORY or checkpoint['revision'] != REVISION
                or package['base_image_id'] != BASE_IMAGE_ID
                or package['architecture'] != 'PaitonDenseQwen3ForCausalLM'
                or package['max_context_length'] != 8192
                or package['max_batched_tokens'] != 128 or package['max_batch_size'] != 1
                or package['physical_cache_blocks'] != 513 or package['reserved_cache_blocks'] != 1
            ):
                raise LocalPackageError('This image is not the qualified short-draft writing package. Website planning is not enabled for it.')
            files = checkpoint['files']
            if not isinstance(files,list) or not files:
                raise ValueError('missing checkpoint inventory')
            names = set()
            for item in files:
                name = item['file']
                if not isinstance(name,str) or Path(name).name != name or name in ('.','..') or name in names:
                    raise ValueError('invalid checkpoint filename')
                names.add(name)
                if not isinstance(item['bytes'],int) or item['bytes'] <= 0:
                    raise ValueError('invalid checkpoint size')
                size = 64 if item['algorithm'] == 'sha256' else 40 if item['algorithm'] == 'git-blob-sha1' else 0
                if not size or not re.fullmatch('[0-9a-f]{'+str(size)+'}',item['digest']):
                    raise ValueError('invalid checkpoint digest')
            if not {'config.json','tokenizer.json','model.safetensors.index.json'} <= names or not any(name.endswith('.safetensors') for name in names):
                raise ValueError('incomplete checkpoint inventory')
        except (KeyError,TypeError,ValueError) as error:
            if isinstance(error,LocalPackageError): raise
            raise LocalPackageError('The local short-draft package metadata is incomplete or invalid.') from error
        self.images[image] = data
        return data

    @staticmethod
    def _fingerprint(directory, files):
        result = []
        for item in files:
            path = directory/item['file']
            try:
                stat = path.stat()
                if not path.is_file() or stat.st_size != item['bytes']:
                    raise OSError('incomplete file')
                result.append((item['file'],str(path.resolve()),stat.st_dev,stat.st_ino,
                    stat.st_size,stat.st_mtime_ns,stat.st_ctime_ns))
            except OSError as error:
                raise LocalPackageError('The pinned short-draft checkpoint is missing or incomplete: '+item['file']) from error
        return tuple(result)

    def validate(self, command, owner, image, directory, revision, image_info):
        if (
            not isinstance(image,str) or not re.fullmatch(r'sha256:[0-9a-f]{64}',image)
            or QUALIFIED_IMAGE_ID is None or image != QUALIFIED_IMAGE_ID
        ):
            raise LocalPackageError('The short-draft runtime has not been qualified for this Studio release. Configure its verified local image after qualification.')
        if revision != REVISION:
            raise LocalPackageError('The short-draft checkpoint revision differs from its fixed writing profile.')
        try:
            inspected = json.loads(image_info)
            if len(inspected) != 1 or inspected[0]['Id'] != image:
                raise ValueError('image identity differs')
        except (ValueError,KeyError,TypeError) as error:
            raise LocalPackageError('The local short-draft image does not match its immutable image ID.') from error
        directory = Path(directory).resolve()
        with self.lock:
            data = self._metadata(command,owner,image)
            files = data['checkpoint']['files']
            fingerprint = self._fingerprint(directory,files)
            key = (image,str(directory),revision)
            cached = self.sources.get(key)
            if cached and cached['fingerprint'] == fingerprint:
                if cached['error']: raise LocalPackageError(cached['error'])
                return data['package']
            error_message = None
            try:
                for item in files:
                    if file_digest(directory/item['file'],item['algorithm']) != item['digest']:
                        raise LocalPackageError('The pinned short-draft checkpoint hash differs: '+item['file']+'. Repair the local checkpoint before retrying.')
                if self._fingerprint(directory,files) != fingerprint:
                    raise LocalPackageError('The short-draft checkpoint changed during verification. Wait for file preparation to finish and retry.')
            except (OSError,LocalPackageError) as error:
                error_message = str(error) if isinstance(error,LocalPackageError) else 'The local short-draft checkpoint could not be read.'
            self.sources[key] = {'fingerprint':fingerprint,'error':error_message}
            if error_message: raise LocalPackageError(error_message)
            return data['package']
