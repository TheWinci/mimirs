#!/usr/bin/env python3
"""Capture exact installed engines, model assets, and host used for a run."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import subprocess


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root',type=Path,required=True)
    args=p.parse_args()
    root=args.root.resolve()
    engines={}
    for name in ['v1','v2']:
        directory=root/'engines'/name
        lock=directory/'bun.lock'
        package=json.loads((directory/'package.json').read_text())
        engines[name]={'package':package,'lock_sha256':digest(lock)}
    binary=root/'engines/mimirs-rust'
    engines['rust']={'sha256':digest(binary),'revision':'35dd0d3'}
    assets=[]
    for directory in [Path.home()/'.cache/mimirs/models/Xenova/all-MiniLM-L6-v2/751bff37182d3f1213fa05d7196b954e230abad9',Path.home()/'Library/Caches/mimirs/models']:
        if directory.exists():
            for asset in sorted(directory.rglob('*')):
                if asset.is_file() and asset.suffix in {'.onnx','.json'}:
                    assets.append({'path':str(asset),'bytes':asset.stat().st_size,'sha256':digest(asset)})
    result={'platform':platform.platform(),'machine':platform.machine(),'cpu':subprocess.check_output(['sysctl','-n','machdep.cpu.brand_string'],text=True).strip(),'logical_cpus':int(subprocess.check_output(['sysctl','-n','hw.logicalcpu'])),'memory_bytes':int(subprocess.check_output(['sysctl','-n','hw.memsize'])),'bun':subprocess.check_output(['bun','--version'],text=True).strip(),'engines':engines,'cached_model_assets':assets,'npm_v1':{'version':'1.8.0','git_head':'8c11a54a5abcb43bf7e757d9f2534fc5bffd6c0d','tarball_sha1':'d8cd84a521be052480d9470a4a76fb31ff4c0fda'},'v2_revision':'122674c8bfbbc3549390743f51396c5f0e4e3537','embedding_cpu_budget':3}
    (root/'provenance.json').write_text(json.dumps(result,indent=2)+'\n')

if __name__=='__main__': main()
