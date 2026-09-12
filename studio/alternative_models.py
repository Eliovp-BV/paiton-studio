"""Task-specific contracts from Paiton's published 2026-09-09 releases."""
GPT_REVISION='6cee5e81ee83917806bbde320786a8fb61efebee'
GPT_IMAGE='ghcr.io/eliovp/paiton-vllm-plugin@sha256:0cf9c11304ade58e91d97db876a4462781fa2c18d2d4846f26d56fe5d207669d'
WAN_IMAGE_ID='sha256:9f9ec035900625fc64eccf6fb3f2ee839cfd9aaa14babbc48c9884cd0c86420f'
WAN_REVISION='c4f60d30c55a624e35427060fdd217579a6c1d77'
FAST_REVISION='3e187042a324f6f5fb68fd22110a78725253de8f'

def hardware(minimum=31):
    return dict(supported_architectures=['gfx1201'],required_device_names=['AMD Radeon AI PRO R9700'],required_vram_gib=32,minimum_reported_vram_gib=minimum,qualification='Published Paiton release tested on the 32 GB Radeon AI PRO R9700. Other GPUs and smaller cards are not qualified.',memory_basis='Release qualification; checkpoint download size is not the VRAM requirement.')

PACKAGES=[dict(id='gptoss',name='Reasoning, writing & chat',model='GPT-OSS-20B MXFP4 · Paiton',revision=GPT_REVISION,integrated=True,adapter='paiton-chat',default_for=['chat','code'],tasks=['write'],capabilities=['text.generate','text.chat','text.code'],vram_gib=17.0,license='Apache-2.0 checkpoint; public runtime notices apply',hardware=hardware(),preparation_note='The large runtime download is separate from the 13.8 GB checkpoint. First-use compilation and model loading can take several minutes.',quality_note='Fast local responses once loaded. Reasoning uses part of the answer budget; review facts and generated code. Code is never executed by Studio.',profiles=[dict(id='gptoss-writing',label='Writing draft · up to 2048 tokens',task='write',roles=['write'],context=8192,max_tokens=2048,quality_note='This model can add unsupported marketing claims even when given factual notes. Review product claims before using the draft.'),dict(id='gptoss-chat',label='Conversation & coding · up to 2048 tokens',task='write',roles=['chat','code'],context=8192,max_tokens=2048)])]
for identity,preset,rev in [('wan','base',WAN_REVISION),('fastwan','fast',FAST_REVISION)]:
    profiles=[]
    shapes=[(832,480),(480,832)] if preset=='base' else [(832,480),(1280,704)]
    for w,h in shapes:
        for frames in (49,121):
            profiles.append(dict(id=f'{identity}-{w}-{h}-{frames}',label=f'{w} × {h} · {frames/24:.2f} seconds · silent',task='video',roles=['video','video_text'] if preset=='base' else ['video_text'],width=w,height=h,frames=frames,fps=24,steps=20 if preset=='base' else 3,preset=preset,engine='stock' if preset=='base' else 'paiton',audio=False))
    PACKAGES.append(dict(id=identity,name='Image & silent video' if preset=='base' else 'Fast silent video',model='Wan2.2 TI2V-5B' if preset=='base' else 'FastWan FullAttn 5B · Paiton',revision=rev,integrated=True,adapter='paiton-wan',default_for=[],tasks=['video'],capabilities=['video.generate','video.animate_image'] if preset=='base' else ['video.generate'],vram_gib=None,license='Apache-2.0 models; ComfyUI GPL-3.0; package notices apply',hardware=hardware(),quality_note='Text or image input. Silent output. Uses the release stock default: Paiton did not improve complete-clip time in the published image tests.' if preset=='base' else 'Three denoiser evaluations for faster previews. Text input only; no image conditioning or audio. Detail and motion can differ from the full model.',profiles=profiles))
