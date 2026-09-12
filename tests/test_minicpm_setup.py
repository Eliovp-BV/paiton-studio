from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import pytest
from studio.setup_alternatives import minicpm5


class Manager:
    def __init__(self,root,fail=False):
        self.root=Path(root);self.downloads=[];self.commands=[];self.configuration=None;self.fail=fail
    def run(self,command,job):
        self.commands.append(command)
        return SimpleNamespace(returncode=0)
    def update(self,*args,**kwargs):pass
    def download(self,url,path,size,digest,job):
        if self.fail:raise ValueError('Checksum mismatch')
        assert len(digest)==64 and size>0
        self.downloads.append((url,path,size,digest))
    def configure(self,updates,job):self.configuration=updates


def test_reuses_local_image_and_registers_pinned_downloads():
    with TemporaryDirectory() as root:
        manager=Manager(root);minicpm5(manager,'test')
        assert len(manager.commands)==1 and manager.commands[0][1:3]==['image','inspect']
        assert manager.downloads
        assert all('/resolve/6c1ee6fa521aa53f47cfb32696e6d8ef5b0db805/' in item[0] for item in manager.downloads)
        assert manager.configuration['minicpm5_image'].startswith('sha256:')
        assert Path(manager.configuration['minicpm5_hub_dir']).is_relative_to(root)


def test_verification_failure_never_registers_package():
    with TemporaryDirectory() as root:
        manager=Manager(root,fail=True)
        with pytest.raises(ValueError,match='Checksum mismatch'):minicpm5(manager,'test')
        assert manager.configuration is None
