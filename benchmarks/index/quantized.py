#!/usr/bin/env python3
"""Compare float32 and q8 weights in an isolated copy of the production Rust CLI."""
import argparse
import array
import datetime
import hashlib
import io
import json
import math
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tarfile

sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
REPO=HERE.parent.parent
sys.path.insert(0,str(HERE.parent/'versions'))
from run import measure, mixed, score

REVISION='751bff37182d3f1213fa05d7196b954e230abad9'
SOURCE_REVISION='35dd0d3e76eeb4b936edd4e9e064314e7e250300'
MODEL_SHA={
    'qdrant-f32':'bbd7b466f6d58e646fdc2bd5fd67b2f5e93c0b687011bd4548c420f7bd46f0c5',
    'xenova-f32':'759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e',
    'xenova-q8':'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1',
}
ENV_KEYS=['MIMIRS_BENCH_MODEL','MIMIRS_BENCH_SHA256','MIMIRS_BENCH_Q8']


def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(out):
    crate=out/'crate';crate.mkdir()
    # Preserve the measured float32 baseline after production moves to q8.
    archive=subprocess.check_output(['git','archive',SOURCE_REVISION,'src','Cargo.toml','Cargo.lock'],cwd=REPO)
    with tarfile.open(fileobj=io.BytesIO(archive)) as files:
        files.extractall(crate,filter='data')
    manifest=crate/'Cargo.toml'
    manifest.write_text(manifest.read_text().replace('edition = "2024"', 'edition = "2024"\nautobins = false')+'\n[[bin]]\nname = "mimirs-quantized-cli"\npath = "src/main.rs"\n')
    path=crate/'src/embedding.rs'
    original=path.read_text()
    code=original.replace('    format!("{MODEL_NAME}@{MODEL_REVISION}")', '''    if let Ok(hash) = std::env::var("MIMIRS_BENCH_SHA256") {
        return format!("{MODEL_NAME}@benchmark-sha256:{hash}");
    }
    format!("{MODEL_NAME}@{MODEL_REVISION}")''',1)
    needle='''            let model = UserDefinedEmbeddingModel::new(read("model.onnx")?, files)
                .with_pooling(Pooling::Mean);'''
    replacement='''            let override_path = std::env::var_os("MIMIRS_BENCH_MODEL");
            let weights = if let Some(path) = override_path {
                self.profile.measure("model_assets", || -> anyhow::Result<Vec<u8>> {
                    use sha2::{Digest, Sha256};
                    let bytes = std::fs::read(path)?;
                    let expected = std::env::var("MIMIRS_BENCH_SHA256")?;
                    ensure!(Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect::<String>() == expected, "benchmark weight checksum mismatch");
                    self.profile.count("model_asset_bytes", bytes.len());
                    self.profile.count("model_assets_cached", 1);
                    Ok(bytes)
                })?
            } else {
                read("model.onnx")?
            };
            let mut model = UserDefinedEmbeddingModel::new(weights, files)
                .with_pooling(Pooling::Mean);
            if std::env::var("MIMIRS_BENCH_Q8").as_deref() == Ok("1") {
                model = model.with_quantization(fastembed::QuantizationMode::Dynamic);
            }'''
    assert code.count(needle)==1
    code=code.replace(needle,replacement,1)
    path.write_text(code)
    baseline=out/'embedding-baseline.rs';baseline.write_text(original)
    diff=subprocess.run(['diff','-u',str(baseline),str(path)],capture_output=True,text=True)
    (out/'embedding.patch').write_text(diff.stdout)
    subprocess.run(['cargo','build','--release','--offline','--manifest-path',str(crate/'Cargo.toml'),'--target-dir',str(REPO/'target')],check=True)
    binary=out/'mimirs-quantized-experiment';shutil.copy2(REPO/'target/release/mimirs-quantized-cli',binary)
    return binary,sha(path)


def model_env(variant, models):
    for key in ENV_KEYS: os.environ.pop(key,None)
    if variant!='qdrant-f32':
        os.environ['MIMIRS_BENCH_MODEL']=str(models[variant])
        os.environ['MIMIRS_BENCH_SHA256']=MODEL_SHA[variant]
        if variant=='xenova-q8': os.environ['MIMIRS_BENCH_Q8']='1'


def index_data(project, extension):
    with sqlite3.connect(f'file:{project}/.mimirs/index.db?mode=ro',uri=True) as db:
        db.enable_load_extension(True);db.load_extension(str(extension));db.enable_load_extension(False)
        inputs=db.execute('SELECT f.path,d.ordinal,d.text,d.evidence FROM retrieval_documents d JOIN files f ON f.id=d.file_id ORDER BY f.path,d.ordinal').fetchall()
        values=[]
        for row in db.execute('SELECT e.embedding FROM retrieval_documents d JOIN files f ON f.id=d.file_id JOIN document_embeddings e ON e.document_id=d.id ORDER BY f.path,d.ordinal'):
            v=array.array('f');v.frombytes(row[0]);values.append(v)
        meta=dict(db.execute('SELECT key,value FROM index_metadata'))
    return inputs,values,meta


def drift(reference,values):
    assert len(reference)==len(values)
    cosines=[]
    for a,b in zip(reference,values):
        assert len(a)==len(b)==384 and all(math.isfinite(x) for x in b)
        cosines.append(sum(x*y for x,y in zip(a,b))/math.sqrt(sum(x*x for x in a)*sum(x*x for x in b)))
    return {'minimum_cosine':min(cosines),'mean_cosine':sum(cosines)/len(cosines),'max_component_difference':max(abs(x-y) for a,b in zip(reference,values) for x,y in zip(a,b))}


def check_guards(root, binary, model):
    env={k:v for k,v in os.environ.items() if k not in ENV_KEYS}
    project=root/'projects/xenova-q8-0';database=project/'.mimirs/index.db'
    before=sha(database)
    result=subprocess.run([str(binary),'search','hybrid search','--limit','5'],cwd=project,env=env,capture_output=True,text=True)
    assert result.returncode!=0 and 'index embedding metadata does not match' in result.stderr
    assert sha(database)==before
    checks={'float_query_against_q8_index':{'rejected':True,'index_unchanged':True,'error':result.stderr.strip()}}
    invalid=root/'invalid-model-check';(invalid/'.mimirs').mkdir(parents=True,exist_ok=True)
    (invalid/'.mimirs/config.toml').write_text('include = ["**/*.ts"]\nexclude = ["**/.mimirs/**"]\nembedding_workers = 3\n')
    env.update(MIMIRS_BENCH_MODEL=str(model),MIMIRS_BENCH_SHA256='0'*64,MIMIRS_BENCH_Q8='1')
    result=subprocess.run([str(binary),'index'],cwd=invalid,env=env,capture_output=True,text=True)
    assert result.returncode!=0 and 'benchmark weight checksum mismatch' in result.stderr
    checks['wrong_weights_checksum']={'rejected':True,'error':result.stderr.strip()}
    (root/'guard-checks.json').write_text(json.dumps(checks,indent=2)+'\n')


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--corpus',type=Path,required=True)
    p.add_argument('--queries',type=Path,required=True)
    p.add_argument('--extension',type=Path,required=True)
    args=p.parse_args();out=args.output.resolve();out.mkdir(parents=True)
    binary,source_sha=prepare(out)
    cache=Path.home()/'.cache/mimirs/models/Xenova/all-MiniLM-L6-v2'/REVISION
    models={'qdrant-f32':Path.home()/'Library/Caches/mimirs/models/models--Qdrant--all-MiniLM-L6-v2-onnx/snapshots/5f1b8cd78bc4fb444dd171e59b18f3a3af89a079/model.onnx','xenova-f32':cache/'onnx/model.onnx','xenova-q8':cache/'onnx/model_quantized.onnx'}
    for variant,path in models.items(): assert sha(path)==MODEL_SHA[variant]
    report={'created_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source_revision':SOURCE_REVISION,'binary_sha256':sha(binary),'patched_source_sha256':source_sha,'cpu_budget':3,'max_tokens':512,'query_sha256':sha(args.queries),'models':{v:{'path':str(p),'sha256':sha(p),'bytes':p.stat().st_size} for v,p in models.items()},'trials':[],'quality':{}}
    queries=json.loads(args.queries.read_text())
    reference_inputs=None;reference_vectors=None
    def save(): (out/'report.json').write_text(json.dumps(report,indent=2)+'\n')
    # Rotate order across three rounds, preserving the original file-by-file loop.
    variants=['qdrant-f32','xenova-f32','xenova-q8']
    for repeat in range(3):
        for variant in variants[repeat:]+variants[:repeat]:
            model_env(variant,models)
            project=out/'projects'/f'{variant}-{repeat}'
            shutil.copytree(args.corpus,project)
            state=project/'.mimirs';state.mkdir()
            (state/'config.toml').write_text('include = ["**/*"]\nexclude = ["**/.mimirs/**"]\nembedding_workers = 3\n')
            folder=out/'runs'/f'{variant}-{repeat}';folder.mkdir(parents=True)
            print('INDEX',variant,repeat,flush=True)
            fresh=measure([str(binary),'index','--profile',str(folder/'profile.json')],project,folder/'fresh')
            profile=json.loads((folder/'profile.json').read_text())
            assert profile['complete'] and profile['counters'].get('model_assets_fetched',0)==0
            inputs,values,meta=index_data(project,args.extension.resolve())
            if reference_inputs is None: reference_inputs=inputs;reference_vectors=values
            assert inputs==reference_inputs,'chunk text/evidence/order changed'
            row={'variant':variant,'repeat':repeat,'fresh':fresh,'embedding_seconds':profile['phases_seconds'].get('embedding',0),'profile':profile,'input_sha256':hashlib.sha256(json.dumps(inputs).encode()).hexdigest(),'documents':len(inputs),'metadata':meta,'drift_to_qdrant':drift(reference_vectors,values),'index_bytes':sum(p.stat().st_size for p in state.iterdir() if p.is_file())}
            row['unchanged']=measure([str(binary),'index'],project,folder/'unchanged')
            report['trials'].append(row);save()
            print('INDEXED',variant,repeat,round(fresh['wall_seconds'],2),'embedding',round(row['embedding_seconds'],2),'min cosine',round(row['drift_to_qdrant']['minimum_cosine'],6),flush=True)
            if repeat==0:
                cases=[];search_dir=folder/'search';search_dir.mkdir()
                for i,q in enumerate(queries):
                    result=measure([str(binary),'search',q['query'],'--limit','100'],project,search_dir/str(i))
                    hits=mixed.parse((search_dir/f'{i}.stdout').read_text())
                    cases.append({'pass':0,'index':i,'ms':result['wall_seconds']*1000,'hits':hits})
                quality=score(queries,cases,{},project)
                report['quality'][variant]=quality
                (folder/'cases.json').write_text(json.dumps(cases)+'\n')
                save();print('QUALITY',variant,{k:v for k,v in quality.items() if k!='cases'},flush=True)
    for key in ENV_KEYS: os.environ.pop(key,None)
    check_guards(out,binary,models['xenova-q8'])
    save()

if __name__=='__main__': main()
