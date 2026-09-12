from types import SimpleNamespace
import pytest
from studio import meeting_runtime
from studio.meetings import Meetings, MeetingInput


def test_stock_default_and_explicit_compiler_selection():
    runtime=SimpleNamespace(config={})
    assert meeting_runtime.profile_for(runtime)==meeting_runtime.PROFILE
    runtime.config['meeting_compiler_enabled']=True
    selected=meeting_runtime.profile_for(runtime)
    assert selected==meeting_runtime.COMPILED_PROFILE
    selected['compiler']=False
    assert meeting_runtime.COMPILED_PROFILE['compiler'] is True


@pytest.mark.parametrize('compiled',[False,True])
def test_queued_profile_controls_actual_command_despite_later_config_change(tmp_path,monkeypatch,compiled):
    item=Meetings(tmp_path).create(MeetingInput(name='Fixture',filename='fixture.wav'))
    commands=[]
    runtime=SimpleNamespace(
        config={'meeting_compiler_enabled':not compiled},
        store=SimpleNamespace(root=tmp_path,status=lambda *args:None),
        check_cancel=lambda job:None,
        config_path=lambda key:str(tmp_path/'models'),
        start=lambda job,image,args,**kwargs:(commands.append(args) or 'owned-test',None),
        stream=lambda *args,**kwargs:None,
        stop=lambda container:None)
    monkeypatch.setattr(meeting_runtime,'preflight',lambda runtime,request:'local-test-image')
    profile=dict(meeting_runtime.COMPILED_PROFILE if compiled else meeting_runtime.PROFILE)
    kind,path,metadata=meeting_runtime.run(runtime,{'id':'job-test','request':dict(
        task='meeting',profile=profile,meeting_id=item['id'],track=0,channel=None)})
    assert kind=='meeting' and path.name=='result.json'
    assert [command[0] for command in commands]==['transcribe','diarize','attribute','normalize','summarize']
    assert ('--artifact' in commands[0]) is compiled
    assert metadata['asr_backend']==('paiton' if compiled else 'stock')
