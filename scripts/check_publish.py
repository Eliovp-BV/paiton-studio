"""Reject research/private files in the history selected for any future publication."""
import subprocess
import sys


def check(ref='HEAD'):
    result=subprocess.run(['git','rev-list','--objects',ref],check=True,capture_output=True,text=True)
    forbidden=[]
    for line in result.stdout.splitlines():
        _,_,path=line.partition(' ')
        if path.split('/')[0] in {'docs','research','.local','.data'} or path in {'config.local.json', 'AGENTS.md', 'web/art/README.md'}:
            forbidden.append(path)
    if forbidden:
        print('Publication blocked: private/research paths remain in the selected Git history.')
        for path in sorted(set(forbidden)): print('  '+path)
        print('Prepare and review a clean publication history without rewriting active worktrees.')
        return 1
    print('No prohibited history paths found. Pushing still requires explicit authorization.')
    return 0


if __name__=='__main__':
    raise SystemExit(check(sys.argv[1] if len(sys.argv)>1 else 'HEAD'))
