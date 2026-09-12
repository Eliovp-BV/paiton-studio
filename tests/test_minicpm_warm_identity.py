import time
from studio.runtime import Runtime


def runtime_with_warm():
    runtime = object.__new__(Runtime)
    runtime._chat_active_until = 0
    runtime.config = {'minicpm5_image':'image-a', 'gptoss_image':'image-a'}
    runtime._warm = {'package':'minicpm5-2b', 'revision':'revision-a', 'image':'image-a',
                     'until':time.monotonic()+60}
    return runtime


def test_warm_reuse_requires_package_revision_and_image():
    runtime = runtime_with_warm()
    request = {'profile':{'package':'minicpm5-2b','revision':'revision-a'}}
    assert runtime.warm_for(request)
    assert not runtime.warm_for({'profile':{'package':'gptoss','revision':'revision-a'}})
    assert not runtime.warm_for({'profile':{'package':'minicpm5-2b','revision':'revision-b'}})
    runtime.config['minicpm5_image'] = 'image-b'
    assert not runtime.warm_for(request)


def test_expired_runtime_is_not_reused():
    runtime = runtime_with_warm()
    runtime._warm['until'] = time.monotonic()-1
    assert not runtime.warm_for({'profile':{'package':'minicpm5-2b','revision':'revision-a'}})


def test_minicpm_chat_preserves_qualified_sampling_and_thinking():
    from studio.chat_adapters import writing_body
    body=writing_body({'profile':{'package':'minicpm5-2b','max_tokens':1024,'roles':['chat']},
                       'messages':[{'role':'user','content':'Hello'}],'seed':1201})
    assert body['temperature']==0
    assert body['seed']==1201
    assert body['chat_template_kwargs']=={'enable_thinking':False}
