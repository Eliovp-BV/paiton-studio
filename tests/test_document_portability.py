from pathlib import Path
import subprocess

import pytest

from studio import documents
from studio.store import Store


def test_document_import_preserves_unicode_and_normalizes_windows_filename(tmp_path):
    store = Store(tmp_path / 'data')
    project = store.create_project()['id']
    source = 'Résumé: café, 日本語, and a launch price of €42.'
    asset = documents.import_document(store, project, r'C:\Users\Creator\résumé.txt', source.encode())
    assert asset['name'] == 'résumé.txt'
    extracted = store.asset(asset['metadata']['extracted_text'])
    assert (store.root / extracted['path']).read_text(encoding='utf-8') == source


@pytest.mark.parametrize('timeout', [False, True])
def test_document_parser_can_reopen_source_and_temporary_input_is_removed(tmp_path, monkeypatch, timeout):
    store = Store(tmp_path / 'data')
    project = store.create_project()['id']
    seen = []
    def parser(command, **kwargs):
        source = Path(command[-2])
        seen.append(source)
        assert source.read_bytes() == b'Private meeting notes'
        assert kwargs['encoding'] == 'utf-8'
        assert kwargs['timeout'] == 20
        # Windows also requires no parent handle preventing rename/reopen.
        moved = source.with_name('reopened.txt')
        source.rename(moved)
        moved.rename(source)
        if timeout:
            raise subprocess.TimeoutExpired(command, 20)
        return subprocess.CompletedProcess(command, 1, '', 'private parser detail')
    monkeypatch.setattr(documents.subprocess, 'run', parser)
    with pytest.raises(ValueError, match='took too long' if timeout else 'could not be read'):
        documents.import_document(store, project, 'notes.txt', b'Private meeting notes')
    assert seen and not seen[0].exists() and not seen[0].parent.exists()
    assert store.assets(project) == []
