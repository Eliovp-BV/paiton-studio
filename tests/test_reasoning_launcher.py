"""CPU launch contract tests: never start a model server."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace


def test_wrapper_preserves_public_paiton_launcher(monkeypatch):
    path=Path(__file__).resolve().parents[1]/'scripts/gptoss_server.py'
    spec=importlib.util.spec_from_file_location('studio_gptoss_wrapper',path)
    wrapper=importlib.util.module_from_spec(spec);spec.loader.exec_module(wrapper)
    calls=[]
    def command(snapshot,stock=False,qualification=False):
        calls.append((snapshot,stock,qualification))
        return ['public-paiton-server','--offline']
    server=SimpleNamespace(command=command)
    def main():
        argv=server.command('/verified/snapshot',qualification=True)
        assert argv[:2]==['public-paiton-server','--offline']
        assert argv[2]=='--reasoning-config'
        config=json.loads(argv[3])
        assert config['reasoning_end_str']=='<|end|><|start|>assistant<|channel|>final<|message|>'
    server.main=main
    monkeypatch.setattr(wrapper.importlib.util,'spec_from_file_location',lambda *a:SimpleNamespace(loader=SimpleNamespace(exec_module=lambda _:None)))
    monkeypatch.setattr(wrapper.importlib.util,'module_from_spec',lambda _:server)
    monkeypatch.setenv('VLLM_USE_V2_MODEL_RUNNER','1')
    wrapper.main()
    assert calls==[('/verified/snapshot',False,True)]
    assert wrapper.os.environ['VLLM_USE_V2_MODEL_RUNNER']=='0'
