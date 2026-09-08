import sys,json,re,statistics,hashlib,subprocess
from pathlib import Path
sys.path.insert(0,'/Users/winci/repos/mimirs/benchmarks/versions')
import run
root=Path('/tmp/mimirs-bun-1.4.2-comparison');out=root/'query-validation'
engines=['baseline','candidate','ts']
binaries={'baseline':root/'engines/mimirs-rust','candidate':out/'mimirs-rust','ts':root/'runtime/bun-darwin-aarch64/bun'}
rows=[]
normalize=lambda s:re.sub(r'(?m)^time: [^\n]+$', 'time: ignored',s,count=1)
for corpus in ['mimirs','excalidraw','django']:
 queries=json.loads((run.HERE/'queries'/f'{corpus}.json').read_text())
 sample=sorted(set(round(i*(len(queries)-1)/9) for i in range(10)))
 for repeat in range(3):
  for ordinal,i in enumerate(sample):
   offset=(repeat+ordinal)%3
   for engine in engines[offset:]+engines[:offset]:
    version='v2' if engine=='ts' else 'rust'
    project=root/'projects'/f'{corpus}-{version}-0'
    cmd=run.command(root,version,project,'search',queries[i]['query'],rust_limit=20)
    cmd[0]=str(binaries[engine])
    prefix=out/'timings'/corpus/engine/f'{repeat}-{i}'
    t=run.measure(cmd,project,prefix)
    if version=='rust':
     expected=(root/'results'/corpus/'rust/search'/f'0-{i}.stdout').read_text()
     assert normalize(prefix.with_suffix('.stdout').read_text())==normalize(expected),(engine,corpus,repeat,i)
    rows.append({'corpus':corpus,'engine':engine,'repeat':repeat,'index':i,**t})
  print('COMPARED',corpus,repeat,flush=True)
result={'source_revision':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'candidate_includes_uncommitted_patch':True,'patch_sha256':hashlib.sha256((out/'candidate.patch').read_bytes()).hexdigest(),'binary_sha256':{e:hashlib.sha256(p.read_bytes()).hexdigest() for e,p in binaries.items()},'method':'Ten fixed queries per corpus, three passes, rotating baseline Rust, candidate Rust and TS on Bun 1.4.2. Identical retained indexes. All 180 timed Rust outputs match baseline exactly except elapsed time.','rows':rows,'summary':{}}
for corpus in ['mimirs','excalidraw','django']:
 result['summary'][corpus]={}
 for engine in engines:
  cases=[r for r in rows if r['corpus']==corpus and r['engine']==engine]
  result['summary'][corpus][engine]={'median_ms':statistics.median(r['wall_seconds']*1000 for r in cases),'pass_medians_ms':[statistics.median(r['wall_seconds']*1000 for r in cases if r['repeat']==p) for p in range(3)],'median_peak_rss_mib':statistics.median(r['peak_rss_bytes']/2**20 for r in cases)}
 print(corpus,result['summary'][corpus])
run.write(out/'comparison.json',result)
