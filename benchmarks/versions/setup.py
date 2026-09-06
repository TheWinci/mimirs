#!/usr/bin/env python3
"""Install the three pinned engines in a new disposable benchmark directory."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
V2 = '122674c8bfbbc3549390743f51396c5f0e4e3537'
V1_SHA1 = 'd8cd84a521be052480d9470a4a76fb31ff4c0fda'


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--binary',type=Path,required=True)
    args=parser.parse_args()
    root=args.root.resolve()
    engines=root/'engines'
    engines.mkdir(parents=True,exist_ok=False)
    v1=engines/'v1'; v1.mkdir()
    result=subprocess.check_output(['npm','pack','mimirs@1.8.0','--json'],cwd=v1)
    (root/'npm-pack.json').write_bytes(result)
    archive=v1/json.loads(result)[0]['filename']
    assert hashlib.sha1(archive.read_bytes()).hexdigest()==V1_SHA1
    with tarfile.open(archive) as tar:
        for member in tar:
            member.name=str(Path(member.name).relative_to('package'))
            tar.extract(member,v1,filter='data')
    shutil.copyfile(HERE/'locks/v1.bun.lock',v1/'bun.lock')
    subprocess.run(['bun','install','--frozen-lockfile'],cwd=v1,check=True)
    v2=engines/'v2'; v2.mkdir()
    data=subprocess.check_output(['git','archive',V2],cwd=REPO)
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        tar.extractall(v2,filter='data')
    subprocess.run(['bun','install','--frozen-lockfile'],cwd=v2,check=True)
    shutil.copy2(args.binary,engines/'mimirs-rust')

if __name__=='__main__': main()
