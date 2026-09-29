"""Managed project source files shared with an external editor; never executed."""
from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import stat
import tempfile
import threading
from typing import Literal
import zipfile

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from .resources import Lease

MAX_FILE_BYTES = 512 * 1024
MAX_FILES = 256
MAX_TOTAL_BYTES = 8 * 1024 * 1024
MAX_SCAN_ENTRIES = 4096
MAX_PATH = 240
MAX_DEPTH = 12
MAX_CONTEXT_FILES = 4
MAX_CONTEXT_CHARACTERS = 12000
MAX_CODING_INSTRUCTIONS = 2000
MAX_SEARCH_MATCHES = 200
MAX_SEARCH_QUERY = 200

LANGUAGES = {
    '.py': 'python', '.pyi': 'python', '.js': 'javascript', '.jsx': 'javascript',
    '.mjs': 'javascript', '.cjs': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
    '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'scss', '.sass': 'sass', '.less': 'less',
    '.json': 'json', '.jsonc': 'json', '.md': 'markdown', '.mdx': 'markdown', '.txt': 'plaintext',
    '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.ini': 'ini', '.cfg': 'ini',
    '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.fish': 'shell', '.sql': 'sql',
    '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp', '.cxx': 'cpp',
    '.rs': 'rust', '.go': 'go', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin',
    '.swift': 'swift', '.cs': 'csharp', '.php': 'php', '.rb': 'ruby', '.r': 'r',
    '.lua': 'lua', '.pl': 'perl', '.vue': 'vue', '.svelte': 'svelte', '.xml': 'xml', '.svg': 'xml',
}
NAMED_FILES = {'Dockerfile': 'dockerfile', 'Makefile': 'makefile', 'CMakeLists.txt': 'cmake',
               'LICENSE': 'plaintext', '.gitignore': 'plaintext', '.gitattributes': 'plaintext',
               '.editorconfig': 'ini', '.dockerignore': 'plaintext', '.prettierignore': 'plaintext'}
IGNORED_DIRS = {'node_modules', 'venv', '__pycache__'}
RESERVED = {'CON', 'PRN', 'AUX', 'NUL', 'CLOCK$', *(f'COM{i}' for i in range(1, 10)), *(f'LPT{i}' for i in range(1, 10))}
SECRET_FILE = re.compile(r'^(?:secrets?|credentials?)(?:\.[^.]+)*\.(?:json|ya?ml|toml|ini|cfg|txt)$', re.I)
STARTERS = {
    'empty': {},
    'python': {'main.py': 'def greet(name: str) -> str:\n    return f"Hello, {name}!"\n\n\nif __name__ == "__main__":\n    print(greet("Paiton Studio"))\n',
               '.gitignore': '__pycache__/\n.venv/\n'},
    'static-web': {
        'index.html': '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>My project</title>\n  <link rel="stylesheet" href="styles.css">\n</head>\n<body>\n  <main>\n    <h1>Make something useful.</h1>\n    <p id="message">Your project starts here.</p>\n    <button id="hello">Say hello</button>\n  </main>\n  <script src="main.js"></script>\n</body>\n</html>\n',
        'styles.css': 'body { margin: 0; font: 18px/1.6 system-ui, sans-serif; background: #f6f4ef; color: #202520; }\nmain { max-width: 48rem; margin: 10vh auto; padding: 2rem; }\nbutton { font: inherit; padding: .5rem 1rem; cursor: pointer; }\n',
        'main.js': 'document.querySelector("#hello").addEventListener("click", () => {\n  document.querySelector("#message").textContent = "Hello from your project!";\n});\n',
    },
}


class CodeFileInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    path: str = Field(min_length=1, max_length=MAX_PATH)
    content: str = Field(max_length=MAX_FILE_BYTES)
    version: str | None = Field(default=None, pattern=r'^[a-f0-9]{64}$')


class StarterInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    template: Literal['empty', 'python', 'static-web']


class CodingContextInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    path: str = Field(min_length=1, max_length=MAX_PATH)
    version: str = Field(pattern=r'^[a-f0-9]{64}$')


class CodingPreferencesInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    profile_id: str = Field(default='auto', min_length=1, max_length=100)
    instructions: str = Field(default='', max_length=MAX_CODING_INSTRUCTIONS)
    version: str | None = Field(default=None, pattern=r'^[a-f0-9]{64}$')


def _is_link(info):
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400))


def code_path(value):
    if not isinstance(value, str) or not value or len(value) > MAX_PATH or '\\' in value or value.startswith('/'):
        raise ValueError('Use a relative code file path, such as src/main.py.')
    parts = value.split('/')
    try:
        if any(len(part.encode('utf-8')) > 200 for part in parts):
            raise ValueError('Keep each file or folder name below 200 UTF-8 bytes.')
    except UnicodeError:
        raise ValueError('Use a valid Unicode file name.') from None
    if len(parts) > MAX_DEPTH or any(not part or part in ('.', '..') or len(part) > 100
            or part.endswith((' ', '.')) or any(ord(char) < 32 or char in '<>:"|?*' for char in part)
            or part.split('.')[0].upper() in RESERVED for part in parts):
        raise ValueError('Use a portable file name without parent paths or special characters.')
    if any(part.startswith('.') or part in IGNORED_DIRS for part in parts[:-1]):
        raise ValueError('Private folders and dependency directories are outside this code workspace.')
    name = parts[-1]
    if name.startswith('.') and name not in NAMED_FILES or SECRET_FILE.fullmatch(name):
        raise ValueError('Private settings and credential files are outside this code workspace.')
    language = NAMED_FILES.get(name) or LANGUAGES.get(PurePosixPath(name).suffix.lower())
    if not language:
        raise ValueError('Choose a supported UTF-8 source or configuration file.')
    return '/'.join(parts), language


def _content_bytes(content):
    try:
        encoded = content.encode('utf-8')
    except (UnicodeError, AttributeError):
        raise ValueError('Save code as UTF-8 text.') from None
    if len(encoded) > MAX_FILE_BYTES:
        raise ValueError('Files larger than 512 KB should be edited in your external editor.')
    if any(ord(char) < 32 and char not in '\n\r\t' or char == '\x7f' for char in content):
        raise ValueError('Binary files cannot be edited in this code workspace.')
    return encoded


class CodeFileAccess:
    """Keep native directory-handle behavior behind the filesystem boundary."""
    def __init__(self, root):
        self.root = root
        self.directory_handles = os.name == 'posix' and os.open in os.supports_dir_fd

    @contextmanager
    def parent(self, path):
        if not self.directory_handles:
            yield None
            return
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, 'O_CLOEXEC', 0)
        descriptor = os.open(self.root, flags)
        try:
            for part in path.parent.relative_to(self.root).parts:
                child = os.open(part, flags, dir_fd=descriptor)
                os.close(descriptor)
                descriptor = child
            yield descriptor
        finally:
            os.close(descriptor)

    def read(self, path):
        flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NONBLOCK', 0)
        with self.parent(path) as directory:
            return os.open(path.name, flags, dir_fd=directory) if directory is not None else os.open(path, flags)

    @contextmanager
    def staged(self, path, content):
        with self.parent(path) as directory:
            temporary = '.studio-code-' + secrets.token_hex(16) + '.tmp'
            location = temporary if directory is not None else path.parent / temporary
            arguments = {'dir_fd': directory} if directory is not None else {}
            descriptor = os.open(location, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, 'O_BINARY', 0), 0o600, **arguments)
            try:
                with os.fdopen(descriptor, 'wb') as stream:
                    stream.write(content)
                    stream.flush()
                    os.fsync(stream.fileno())
                yield directory, location
            finally:
                try:
                    os.unlink(location, **arguments)
                except FileNotFoundError:
                    pass

    @staticmethod
    def same_parent(path, directory):
        return directory is None or os.path.samestat(os.fstat(directory), path.parent.stat())

    @staticmethod
    def publish(path, directory, temporary, create):
        if directory is None:
            if create:
                os.link(temporary, path)
            else:
                os.chmod(temporary, stat.S_IMODE(path.stat().st_mode))
                os.replace(temporary, path)
        elif create:
            os.link(temporary, path.name, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
        else:
            mode = stat.S_IMODE(os.stat(path.name, dir_fd=directory, follow_symlinks=False).st_mode)
            os.chmod(temporary, mode, dir_fd=directory)
            os.replace(temporary, path.name, src_dir_fd=directory, dst_dir_fd=directory)


class CodingWorkspace:
    def __init__(self, store, chats=None):
        self.store = store
        self.lock = threading.RLock()
        self.access = CodeFileAccess(store.root)

    def _check(self, path, allow_missing=True):
        """Reject links/reparse points in every managed path component, including root."""
        try:
            relative = path.relative_to(self.store.root)
        except ValueError:
            raise ValueError('This file is outside the project code workspace.') from None
        current = self.store.root
        for index, part in enumerate(('', *relative.parts)):
            if part:
                current = current / part
            try:
                info = current.lstat()
            except FileNotFoundError:
                if allow_missing:
                    return
                raise HTTPException(404, 'Code file not found.') from None
            if _is_link(info):
                raise ValueError('Linked files or folders cannot be opened through Studio. Use a regular project folder.')
            if index < len(relative.parts) and not stat.S_ISDIR(info.st_mode):
                raise ValueError('A parent code path is not a directory.')

    def _root(self, project):
        self._check(self.store.root, allow_missing=False)
        self.store.project(project)
        if not re.fullmatch(r'[a-f0-9]{32}', project):
            raise ValueError('Invalid project identity.')
        root = self.store.root / 'projects' / project / 'code'
        self._check(root)
        if root.exists() and not root.is_dir():
            raise ValueError('The project code folder is not a directory.')
        return root

    def _target(self, root, path):
        relative, language = code_path(path)
        target = root.joinpath(*relative.split('/'))
        self._check(target)
        return target, relative, language

    def _read(self, target, relative, language):
        self._check(target, allow_missing=False)
        descriptor = None
        try:
            descriptor = self.access.read(target)
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode):
                raise ValueError('Choose a regular UTF-8 code file.')
            if info.st_nlink > 1:
                raise ValueError('Shared hard-linked files are outside this code workspace. Make a regular copy first.')
            if info.st_size > MAX_FILE_BYTES:
                raise ValueError('Files larger than 512 KB should be edited in your external editor.')
            # Recheck directories before reading an externally editable file.
            self._check(target, allow_missing=False)
            with os.fdopen(descriptor, 'rb') as stream:
                descriptor = None
                content = stream.read(MAX_FILE_BYTES + 1)
            if len(content) > MAX_FILE_BYTES:
                raise ValueError('Files larger than 512 KB should be edited in your external editor.')
            try:
                text = content.decode('utf-8')
            except UnicodeError:
                raise ValueError('Binary files cannot be edited in this code workspace.') from None
            _content_bytes(text)
            return {'path': relative, 'language': language, 'size': len(content),
                    'version': hashlib.sha256(content).hexdigest(), 'updated_at': info.st_mtime,
                    'content': text}
        except FileNotFoundError:
            raise HTTPException(404, 'Code file not found.') from None
        except OSError:
            raise ValueError('This code file could not be read. Check its permissions in your external editor.') from None
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def snapshot(self, project):
        root = self._root(project)
        files, skipped = [], {}
        scanned, total, over_limit, truncated = 0, 0, False, False
        def skip(reason):
            skipped[reason] = skipped.get(reason, 0) + 1
        def visit(directory, depth):
            nonlocal scanned, total, over_limit, truncated
            if depth > MAX_DEPTH:
                skip('depth')
                truncated = True
                return
            entries = []
            try:
                self._check(directory, allow_missing=False)
                with os.scandir(directory) as iterator:
                    for entry in iterator:
                        scanned += 1
                        if scanned > MAX_SCAN_ENTRIES:
                            truncated = True
                            break
                        entries.append(entry)
            except (OSError, HTTPException, ValueError):
                skip('unreadable')
                return
            for entry in sorted(entries, key=lambda item: item.name):
                if over_limit:
                    return
                path = directory / entry.name
                try:
                    info = entry.stat(follow_symlinks=False)
                    if _is_link(info):
                        skip('links')
                        continue
                    if stat.S_ISDIR(info.st_mode):
                        if entry.name.startswith('.') or entry.name in IGNORED_DIRS:
                            skip('private_or_dependencies')
                        elif not truncated:
                            visit(path, depth + 1)
                        continue
                    if not stat.S_ISREG(info.st_mode):
                        skip('special')
                        continue
                    relative, language = code_path(path.relative_to(root).as_posix())
                    if info.st_size > MAX_FILE_BYTES:
                        skip('oversize')
                        continue
                    item = self._read(path, relative, language)
                    total += item['size']
                    if len(files) >= MAX_FILES or total > MAX_TOTAL_BYTES:
                        over_limit = True
                        return
                    files.append({key: value for key, value in item.items() if key != 'content'})
                except (ValueError, OSError, HTTPException):
                    skip('unsupported_or_unreadable')
        if root.exists():
            visit(root, 1)
        return {'project_id': project, 'root': str(root), 'exists': root.exists(),
                'files': sorted(files, key=lambda item: item['path']), 'total_bytes': total,
                'skipped': sum(skipped.values()), 'skipped_reasons': skipped,
                'over_limit': over_limit, 'truncated': truncated, 'starters': list(STARTERS),
                'limits': {'file_bytes': MAX_FILE_BYTES, 'files': MAX_FILES, 'total_bytes': MAX_TOTAL_BYTES},
                'execution_enabled': False}

    def read(self, project, path):
        root = self._root(project)
        return self._read(*self._target(root, path))

    def search(self, project, query, case_sensitive=False):
        """Literal, bounded search of the same managed files exposed by the editor."""
        if not isinstance(query, str) or not query or len(query) > MAX_SEARCH_QUERY or any(ord(char) < 32 for char in query):
            raise ValueError('Search for 1–200 characters on a single line.')
        expression = re.compile(re.escape(query), 0 if case_sensitive else re.IGNORECASE)
        snapshot = self.snapshot(project)
        matches, searched, limit_reached = [], 0, False
        for item in snapshot['files']:
            try:
                current = self.read(project, item['path'])
            except (HTTPException, ValueError, OSError):
                raise HTTPException(409, 'A code file changed while searching. Search again to review its current version.') from None
            if current['version'] != item['version']:
                raise HTTPException(409, 'A code file changed while searching. Search again to review its current version.')
            searched += 1
            offset = 0
            for number, line_match in enumerate(re.finditer(r'[^\n]*\n|[^\n]+$', current['content']), 1):
                line = line_match.group()
                for match in expression.finditer(line):
                    if len(matches) >= MAX_SEARCH_MATCHES:
                        limit_reached = True
                        break
                    start = max(0, match.start() - 60)
                    end = min(len(line.rstrip('\r\n')), match.end() + 120)
                    # Browser text selection uses UTF-16 offsets, including surrogate pairs.
                    begin = offset + len(line[:match.start()].encode('utf-16-le')) // 2
                    finish = offset + len(line[:match.end()].encode('utf-16-le')) // 2
                    matches.append({'path': item['path'], 'version': item['version'],
                                    'line': number, 'column': match.start() + 1,
                                    'start': begin, 'end': finish,
                                    'preview': line[start:end], 'preview_start': start,
                                    'match': match.group()})
                if limit_reached:
                    break
                offset += len(line.encode('utf-16-le')) // 2
            if limit_reached:
                break
        return {'query': query, 'case_sensitive': case_sensitive, 'matches': matches,
                'searched_files': searched, 'limit_reached': limit_reached,
                'partial': snapshot['truncated'] or snapshot['over_limit'],
                'skipped': snapshot['skipped'], 'max_matches': MAX_SEARCH_MATCHES}

    def context(self, project, selections):
        """Capture only explicitly selected, reviewed revisions for one chat turn."""
        if len(selections) > MAX_CONTEXT_FILES:
            raise ValueError('Choose at most 4 supporting code files.')
        entries, seen, total = [], set(), 0
        for selection in selections:
            selection = CodingContextInput.model_validate(selection)
            relative, _ = code_path(selection.path)
            if relative in seen:
                raise ValueError(f'Supporting file "{relative}" was selected more than once.')
            seen.add(relative)
            try:
                current = self.read(project, relative)
            except HTTPException as error:
                if error.status_code != 404:
                    raise
                raise HTTPException(409, f'Supporting file "{relative}" is no longer available. Refresh the file list and select its current version.') from None
            if current['version'] != selection.version:
                raise HTTPException(409, f'Supporting file "{relative}" changed after selection. Review its current contents and select it again.')
            characters = len(current['content'])
            total += characters
            if total > MAX_CONTEXT_CHARACTERS:
                raise ValueError(f'Supporting files contain {total:,} characters; the limit is 12,000. Remove a file or attach a smaller selection in the editor. No files were sent.')
            entries.append({**current, 'characters': characters, 'source': 'project-code'})
        return entries

    @staticmethod
    def _preferences_value(row):
        if row is None:
            return {'profile_id': 'auto', 'instructions': '', 'version': None}
        saved = row['value']
        return {**json.loads(saved), 'version': hashlib.sha256(saved.encode('utf-8')).hexdigest()}

    def preferences(self, project):
        self._check(self.store.root, allow_missing=False)
        self.store.project(project)
        with self.store.connect() as db:
            row = db.execute('SELECT value FROM preferences WHERE key=?', ('coding:' + project,)).fetchone()
        return self._preferences_value(row)

    def save_preferences(self, project, body):
        from .registry import compatible_profiles
        body = CodingPreferencesInput.model_validate(body)
        self._check(self.store.root, allow_missing=False)
        self.store.project(project)
        if body.profile_id != 'auto' and body.profile_id not in {profile['id'] for profile in compatible_profiles('code')}:
            raise ValueError('Choose a model profile that supports coding.')
        _content_bytes(body.instructions)
        value = json.dumps(body.model_dump(exclude={'version'}), sort_keys=True, separators=(',', ':'))
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT value FROM preferences WHERE key=?', ('coding:' + project,)).fetchone()
            if self._preferences_value(row)['version'] != body.version:
                raise HTTPException(409, 'Coding preferences changed in another window. Reload them before saving; your changes have not been applied.')
            db.execute('INSERT INTO preferences(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ('coding:' + project, value))
        return self._preferences_value({'value': value})

    @contextmanager
    def _write_lock(self, project):
        with self.lock:
            lease = Lease(self.store.root / f'code-write-{project}.lock')
            if not lease.acquire():
                raise HTTPException(409, 'Another code save is in progress. Retry in a moment.')
            try:
                yield
            finally:
                lease.close()

    @staticmethod
    def _conflict():
        raise HTTPException(409, 'This file changed in your external editor or another window. Reload it before saving; your draft has not been applied.')

    def _save(self, target, relative, language, encoded, version):
        with self.access.staged(target, encoded) as (directory, temporary):
            self._check(target)
            latest = self._read(target, relative, language) if target.exists() else None
            if (latest['version'] if latest else None) != version or not self.access.same_parent(target, directory):
                self._conflict()
            try:
                self.access.publish(target, directory, temporary, create=version is None)
            except FileExistsError:
                self._conflict()
            self._check(target)
            if not self.access.same_parent(target, directory):
                self._conflict()

    def write(self, project, path, content, version=None):
        encoded = _content_bytes(content)
        if version is not None and (not isinstance(version, str) or not re.fullmatch(r'[a-f0-9]{64}', version)):
            raise ValueError('Use the exact version returned when opening this file.')
        root = self._root(project)
        target, relative, language = self._target(root, path)
        with self._write_lock(project):
            self._check(target)
            existing = self._read(target, relative, language) if target.exists() else None
            if (existing is None and version is not None) or (existing is not None and existing['version'] != version):
                self._conflict()
            snapshot = self.snapshot(project)
            if snapshot['over_limit'] or snapshot['truncated']:
                raise ValueError('This folder exceeds Studio’s editing limits. Use your external editor or a smaller project.')
            if existing is None and len(snapshot['files']) >= MAX_FILES:
                raise ValueError('This workspace already contains 256 files. Use your external editor for larger projects.')
            if snapshot['total_bytes'] - (existing['size'] if existing else 0) + len(encoded) > MAX_TOTAL_BYTES:
                raise ValueError('Keep the browser workspace below 8 MB of source files.')
            target.parent.mkdir(parents=True, exist_ok=True)
            self._check(target)
            self._save(target, relative, language, encoded, version)
            return self._read(target, relative, language)

    def starter(self, project, template):
        if template not in STARTERS:
            raise ValueError('Choose an empty, Python or static web starter.')
        root = self._root(project)
        with self._write_lock(project):
            self._check(root)
            if root.exists() and next(root.iterdir(), None) is not None:
                raise HTTPException(409, 'This project already has code files. Starters only create an empty workspace.')
            root.parent.mkdir(parents=True, exist_ok=True)
            self._check(root)
            # Prepare the complete starter before making the code folder visible.
            # Replacing a now-nonempty folder fails instead of losing new files.
            with tempfile.TemporaryDirectory(prefix='.code-starter-', dir=root.parent) as temporary:
                staged = Path(temporary) / 'code'
                staged.mkdir()
                for path, content in STARTERS[template].items():
                    (staged / path).write_bytes(_content_bytes(content))
                self._check(root)
                if root.exists() and next(root.iterdir(), None) is not None:
                    raise HTTPException(409, 'This project changed while preparing its starter. Existing files were kept.')
                try:
                    os.replace(staged, root)
                except OSError:
                    raise HTTPException(409, 'The code folder changed while preparing its starter. Existing files were kept.') from None
        return self.snapshot(project)

    def export_entries(self, project):
        """Read one bounded source snapshot, without host paths or private files."""
        snapshot = self.snapshot(project)
        if snapshot['over_limit'] or snapshot['truncated']:
            raise ValueError('This folder exceeds Studio’s export limits. Export it with your external editor.')
        if snapshot['skipped_reasons'].get('oversize'):
            raise ValueError('This folder contains source files larger than 512 KB. Export it with your external editor.')
        entries, total = [], 0
        for item in snapshot['files']:
            current = self.read(project, item['path'])
            if current['version'] != item['version']:
                raise HTTPException(409, 'A code file changed while exporting. Refresh the file list and try again.')
            content = current['content'].encode('utf-8')
            total += len(content)
            if total > MAX_TOTAL_BYTES:
                raise HTTPException(409, 'The project grew while exporting. Refresh the file list and try again.')
            entries.append({**item, 'content': content})
        return entries

    def export(self, project):
        entries = self.export_entries(project)
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as archive:
            for item in entries:
                archive.writestr(item['path'], item['content'])
        return Response(stream.getvalue(), media_type='application/zip',
                        headers={'Content-Disposition': f'attachment; filename="paiton-code-{project[:8]}.zip"'})

    def router(self):
        router = APIRouter()

        @router.get('/api/projects/{project_id}/code')
        def snapshot(project_id: str):
            return self.snapshot(project_id)

        @router.get('/api/projects/{project_id}/code/file')
        def read(project_id: str, path: str = Query(min_length=1, max_length=MAX_PATH)):
            return self.read(project_id, path)

        @router.get('/api/projects/{project_id}/code/search')
        def search(project_id: str, query: str = Query(min_length=1, max_length=MAX_SEARCH_QUERY), case_sensitive: bool = False):
            return self.search(project_id, query, case_sensitive)

        @router.get('/api/projects/{project_id}/code/preferences')
        def preferences(project_id: str):
            return self.preferences(project_id)

        @router.put('/api/projects/{project_id}/code/preferences')
        def save_preferences(project_id: str, body: CodingPreferencesInput):
            return self.save_preferences(project_id, body)

        @router.put('/api/projects/{project_id}/code/file')
        def write(project_id: str, body: CodeFileInput):
            return self.write(project_id, **body.model_dump())

        @router.post('/api/projects/{project_id}/code/starter')
        def starter(project_id: str, body: StarterInput):
            return self.starter(project_id, body.template)

        @router.get('/api/projects/{project_id}/code/export.zip')
        def export(project_id: str):
            return self.export(project_id)

        return router
