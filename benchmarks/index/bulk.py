#!/usr/bin/env python3
"""Screen full-index embedding queues using frozen production chunk texts."""
import argparse
import array
import hashlib
import itertools
import json
import math
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import time

HERE=Path(__file__).resolve().parent
REPO=HERE.parent.parent


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--project',type=Path,required=True)
    p.add_argument('--snapshot',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--all-in-one',action='store_true')
    p.add_argument('--resume',action='store_true')
    args=p.parse_args();out=args.output.resolve();out.mkdir(parents=True,exist_ok=args.resume)
    crate=out/'crate';crate.mkdir(exist_ok=args.resume)
    (crate/'Cargo.toml').write_text(f'''[package]
name = "mimirs-bulk-probe"
version = "0.0.0"
edition = "2024"
[[bin]]
name = "mimirs-bulk-probe"
path = "{HERE / 'bulk_probe.rs'}"
[dependencies]
anyhow = "=1.0.104"
fastembed = {{ version = "=6.0.2", default-features = false, features = ["hf-hub-rustls-tls", "ort-download-binaries-rustls-tls"] }}
serde_json = "=1.0.151"
tokenizers = {{ version = "=0.22.2", default-features = false, features = ["onig"] }}
''')
    shutil.copyfile(REPO/'Cargo.lock',crate/'Cargo.lock')
    subprocess.run(['cargo','build','--release','--offline','--manifest-path',str(crate/'Cargo.toml'),'--target-dir',str(REPO/'target')],check=True)
    binary=REPO/'target/release/mimirs-bulk-probe'
    with sqlite3.connect(f'file:{args.project.resolve()}/.mimirs/index.db?mode=ro',uri=True) as db:
        rows=db.execute('SELECT d.id,f.path,d.ordinal,d.text FROM retrieval_documents d JOIN files f ON f.id=d.file_id ORDER BY f.path,d.ordinal').fetchall()
    batches=[]
    for _,group in itertools.groupby(rows,key=lambda r:r[1]):
        texts=[r[3] for r in group]
        batches.extend(texts[i:i+256] for i in range(0,len(texts),256))
    inputs=out/'batches.json';inputs.write_text(json.dumps(batches)+'\n')
    (out/'documents.json').write_text(json.dumps([{'id':r[0],'path':r[1],'ordinal':r[2]} for r in rows])+'\n')
    report={'documents':len(rows),'cpu_budget':3,'input_sha256':hashlib.sha256(inputs.read_bytes()).hexdigest(),'binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'source_sha256':hashlib.sha256((HERE/'bulk_probe.rs').read_bytes()).hexdigest(),'runs':[]}
    reference=None
    if args.resume:
        previous=json.loads((out/'report.json').read_text())
        assert all(previous[k]==report[k] for k in ['input_sha256','binary_sha256','source_sha256','cpu_budget'])
        report=previous
        reference=array.array('f');reference.frombytes((out/'baseline.bin').read_bytes())
    def trial(mode,size,label):
        nonlocal reference
        if any(r['label']==label for r in report['runs']): return
        prefix=out/label
        cmd=[str(binary),str(args.snapshot.resolve()),str(inputs),mode,str(size),str(prefix.with_suffix('.bin')),'3']
        start=time.perf_counter();peak=0;stopped=None
        with prefix.with_suffix('.stdout').open('w') as stdout,prefix.with_suffix('.stderr').open('w') as stderr:
            proc=subprocess.Popen(['/usr/bin/time','-l','-o',str(prefix.with_suffix('.time')),*cmd],stdout=stdout,stderr=stderr,start_new_session=True)
            while proc.poll() is None:
                # /usr/bin/time launches the probe as its child. Bound only this experiment.
                children=subprocess.check_output(['ps','-Ao','ppid=,rss='],text=True)
                rss=sum(int(line.split()[1])*1024 for line in children.splitlines() if int(line.split()[0])==proc.pid)
                peak=max(peak,rss)
                if peak>8*2**30 or time.perf_counter()-start>180:
                    stopped='memory_limit_8_GiB' if peak>8*2**30 else 'timeout_180_seconds'
                    os.killpg(proc.pid,15);proc.wait();break
                time.sleep(.25)
        wall=time.perf_counter()-start
        row={'label':label,'command':cmd,'wall_seconds':wall,'status':stopped or ('ok' if proc.returncode==0 else 'failed'),'sampled_peak_rss_bytes':peak}
        if row['status']=='ok':
            row.update(json.loads(prefix.with_suffix('.stdout').read_text()))
            match=re.search(r'(\d+)\s+maximum resident set size',prefix.with_suffix('.time').read_text());row['peak_rss_bytes']=int(match[1])
            values=array.array('f');values.frombytes(prefix.with_suffix('.bin').read_bytes())
            assert len(values)==len(rows)*384 and all(math.isfinite(v) for v in values)
            if reference is None: reference=values
            cosines=[]
            for i in range(0,len(values),384):
                a,b=reference[i:i+384],values[i:i+384]
                cosines.append(sum(x*y for x,y in zip(a,b))/math.sqrt(sum(x*x for x in a)*sum(x*x for x in b)))
            row['minimum_cosine_to_baseline']=min(cosines)
            row['max_component_difference']=max(abs(a-b) for a,b in zip(reference,values))
        report['runs'].append(row);(out/'report.json').write_text(json.dumps(report,indent=2)+'\n')
        print(label,row['status'],row.get('work_seconds'),row.get('peak_rss_bytes'),flush=True)
    modes=[('per-file',1,'baseline'),('global-single',1,'global-single'),('bulk',32,'bulk-32'),('sorted',32,'sorted-32'),('sorted',128,'sorted-128')]
    if args.all_in_one: modes.append(('bulk',len(rows),'all-in-one'))
    for mode,size,label in modes: trial(mode,size,label)
    successful=[r for r in report['runs'] if r['status']=='ok' and r['label']!='baseline' and 'repeat' not in r['label']]
    best=min(successful,key=lambda r:r['work_seconds'])
    for mode,size,label in [(best['mode'],best['batch_size'],'best-repeat-2'),('per-file',1,'baseline-repeat-2'),('per-file',1,'baseline-repeat-3'),(best['mode'],best['batch_size'],'best-repeat-3')]: trial(mode,size,label)
    report['selected']={'mode':best['mode'],'batch_size':best['batch_size']}
    (out/'report.json').write_text(json.dumps(report,indent=2)+'\n')

if __name__=='__main__': main()
