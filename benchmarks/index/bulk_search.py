#!/usr/bin/env python3
"""Run production Rust hybrid search against disposable copies of bulk vectors."""
import argparse
import array
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys

sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/'versions'))
from run import mixed, score


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--experiment',type=Path,required=True)
    p.add_argument('--project',type=Path,required=True)
    p.add_argument('--binary',type=Path,required=True)
    p.add_argument('--extension',type=Path,required=True)
    p.add_argument('--queries',type=Path,required=True)
    args=p.parse_args();out=args.experiment.resolve();source=args.project.resolve()
    report=json.loads((out/'report.json').read_text())
    documents=json.loads((out/'documents.json').read_text())
    queries=json.loads(args.queries.read_text())
    project=out/'search-project';shutil.copytree(source,project)
    result={'query_sha256':hashlib.sha256(args.queries.read_bytes()).hexdigest(),'binary_sha256':hashlib.sha256(args.binary.read_bytes()).hexdigest(),'method':'Production CLI with limit 100, first twenty distinct files. Only embedding rows change in a disposable database; source, chunks, facts, relations, and query embeddings stay fixed.','modes':{}}
    path=project/'.mimirs/index.db'
    with sqlite3.connect(path) as db:
        db.enable_load_extension(True);db.load_extension(str(args.extension.resolve()));db.enable_load_extension(False)
        actual=db.execute('SELECT d.id,f.path,d.ordinal FROM retrieval_documents d JOIN files f ON f.id=d.file_id ORDER BY f.path,d.ordinal').fetchall()
        assert actual==[(d['id'],d['path'],d['ordinal']) for d in documents]
        production=b''.join(row[0] for d in documents for row in db.execute('SELECT embedding FROM document_embeddings WHERE document_id=?',[d['id']]))
        baseline=(out/'baseline.bin').read_bytes()
        a=array.array('f');a.frombytes(production);b=array.array('f');b.frombytes(baseline)
        result['baseline_max_difference_to_production']=max(abs(x-y) for x,y in zip(a,b))
    for row in report['runs']:
        if row['status']!='ok' or 'repeat' in row['label']: continue
        label=row['label'];raw=(out/f'{label}.bin').read_bytes();assert len(raw)==len(documents)*1536
        with sqlite3.connect(path) as db:
            db.enable_load_extension(True);db.load_extension(str(args.extension.resolve()));db.enable_load_extension(False)
            db.executemany('UPDATE document_embeddings SET embedding=? WHERE document_id=?',[(raw[i*1536:(i+1)*1536],d['id']) for i,d in enumerate(documents)])
        cases=[];folder=out/'search'/label;folder.mkdir(parents=True)
        for i,q in enumerate(queries):
            run=subprocess.run([str(args.binary.resolve()),'search',q['query'],'--limit','100'],cwd=project,capture_output=True,text=True,check=True)
            (folder/f'{i}.txt').write_text(run.stdout)
            cases.append({'pass':0,'index':i,'hits':mixed.parse(run.stdout)})
        quality=score(queries,cases,{},project)
        result['modes'][label]=quality
        if label!='baseline':
            reference=result['modes']['baseline']['cases']
            quality['file_ranking_changes']=sum(a['paths']!=b['paths'] for a,b in zip(reference,quality['cases']))
        (out/'search-report.json').write_text(json.dumps(result,indent=2)+'\n')
        print(label,{k:v for k,v in quality.items() if k!='cases'},flush=True)

if __name__=='__main__': main()
