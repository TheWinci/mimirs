import sys,json,subprocess,statistics,hashlib
from pathlib import Path
sys.path.insert(0,'/Users/winci/repos/mimirs/benchmarks/versions')
import run
root=Path('/tmp/mimirs-bun-1.4.2-comparison')
binary=Path('/Users/winci/repos/mimirs/target/release/mimirs-search-phases')
rows=[]
for corpus in ['mimirs','excalidraw','django']:
 queries=json.loads((run.HERE/'queries'/f'{corpus}.json').read_text())
 expected=json.loads((root/'results'/corpus/'rust/quality.json').read_text())['cases']
 sample=sorted(set(round(i*(len(queries)-1)/9) for i in range(10)))
 for repeat in range(3):
  for i in sample:
   prefix=root/'search-phases'/corpus/f'{repeat}-{i}'
   def ts_peer():
    project=root/'projects'/f'{corpus}-v2-0'
    cmd=run.command(root,'v2',project,'search',queries[i]['query'])
    cmd[0]=str(root/'runtime/bun-darwin-aarch64/bun')
    return run.measure(cmd,project,root/'search-phases-ts'/corpus/f'{repeat}-{i}')
   peer=ts_peer() if (repeat+i)%2==0 else None
   timing=run.measure([str(binary),str(root/'projects'/f'{corpus}-rust-0'),queries[i]['query']],root,prefix)
   if peer is None: peer=ts_peer()
   value=json.loads(prefix.with_suffix('.stdout').read_text())
   assert value['paths']==expected[i]['paths'],(corpus,repeat,i)
   rows.append({'corpus':corpus,'repeat':repeat,'index':i,'timing':timing,'ts_peer_timing':peer,**value})
  print('PHASES',corpus,repeat,flush=True)
result={'source_revision':'0e69ce986536a783a4025def82dc1c7024b16d9a','binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'probe_source_sha256':hashlib.sha256((root/'search-phases.rs').read_bytes()).hexdigest(),'scope':'Separate diagnostic executable calls unchanged production functions. Alternates the probe with production TS CLI calls in the same order as the latency benchmark. Each invocation opens a database and loads a model, then returns paths rather than formatted source. Phase times exclude process startup/exit and final output. No production source changed. All 90 rankings match the production CLI.','rows':rows}
run.write(root/'search-phases.json',result)
for corpus in ['mimirs','excalidraw','django']:
 cases=[r for r in rows if r['corpus']==corpus]
 print(corpus,{k:round(statistics.median(v[k] for v in cases),2) for k in cases[0] if k.endswith('_ms')})
