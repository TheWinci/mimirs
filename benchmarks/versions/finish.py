#!/usr/bin/env python3
"""Keep a long comparison running and publish its final status to the report."""
import argparse
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import time

HERE=Path(__file__).resolve().parent


def process_identity(pid):
    result=subprocess.run(['ps','-p',str(pid),'-o','lstart=,command='],capture_output=True,text=True)
    return result.stdout.strip() if result.returncode==0 else None


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--after-pid',type=int)
    args=parser.parse_args();root=args.root.resolve()
    state_path=root/'summary/RUN.json'
    def state(status,**extra):
        state_path.write_text(json.dumps({'status':status,'supervisor_pid':os.getpid(),'updated_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'raw_directory':str(root),'log':str(root/'full.log'),**extra},indent=2)+'\n')
    identity=process_identity(args.after_pid) if args.after_pid else None
    state('running',active_runner_pid=args.after_pid)
    if identity:
        while process_identity(args.after_pid)==identity: time.sleep(5)
    # A completed pair has its own marker. If the original process was interrupted,
    # retry unfinished pairs once using fresh disposable trial directories.
    pairs=[root/'results'/c/v/'complete.json' for c in ['mimirs','excalidraw','django','kubernetes'] for v in ['v1','v2','rust']]
    if not all(p.exists() for p in pairs):
        state('resuming_incomplete_pairs')
        with (root/'resume.log').open('w') as log:
            subprocess.run([sys.executable,str(HERE/'run.py'),'--root',str(root)],stdout=log,stderr=subprocess.STDOUT)
    result=subprocess.run([sys.executable,str(HERE/'report.py'),'--root',str(root),'--output',str(root/'summary')],capture_output=True,text=True)
    summary=json.loads((root/'summary/summary.json').read_text())
    if result.returncode or summary['incomplete']:
        state('failed',incomplete=summary['incomplete'],report_error=result.stderr[-4000:])
        return 1
    state('complete',completed_pairs=len(summary['pairs']),queries_per_engine=summary['aggregate']['engines']['rust']['queries'])
    return 0

if __name__=='__main__': sys.exit(main())
