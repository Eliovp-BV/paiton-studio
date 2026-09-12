"""Deleted private files must not leak through a public branch's ancestry."""
from pathlib import Path
import shutil
import subprocess

import pytest

from scripts.check_publish import check


@pytest.mark.skipif(shutil.which('git') is None, reason='Git history check needs Git')
def test_clean_publication_tree_does_not_imply_clean_history(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    def git(*args):
        return subprocess.run(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                               *args], check=True, capture_output=True, text=True).stdout.strip()

    git('init', '-q')
    for name in ('docs/notes.md', 'AGENTS.md', 'web/art/README.md'):
        path = Path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('private development material for ' + name)
    Path('README.md').write_text('Consumer installation instructions')
    git('add', '.')
    git('commit', '-qm', 'Local development')
    git('rm', '-r', 'docs', 'AGENTS.md', 'web/art/README.md')
    git('commit', '-qm', 'Remove internal files')
    assert check() == 1
    output = capsys.readouterr().out
    assert all(name in output for name in ('docs/notes.md', 'AGENTS.md', 'web/art/README.md'))
    # A separate parentless commit preserves local history while offering only
    # the reviewed current tree to a future public repository.
    public = git('commit-tree', 'HEAD^{tree}', '-m', 'Consumer source snapshot')
    assert check(public) == 0
    assert 'No prohibited history paths' in capsys.readouterr().out
