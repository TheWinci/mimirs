"""Check that saved CLI rankings match the production API used for scoring."""
import json
import re
from run import relative_path, unique_paths


def check(root, corpus, version):
    pair=root/'results'/corpus/version
    project=root/'projects'/f'{corpus}-{version}-0'
    cases=json.loads((pair/'warm.json').read_text())['cases']
    checks=[]
    for entry in json.loads((pair/'cli.json').read_text()):
        raw=(pair/'search'/f"{entry['repeat']}-{entry['index']}.stdout").read_text()
        pattern=r'^\d+\.\d+  (.+)$' if version=='v1' else r'^(.+?):\d+(?:-\d+)?  .+  score [-\d.]+'
        paths=[relative_path(p,project) for p in re.findall(pattern,raw,re.M)]
        expected=unique_paths(cases[entry['index']]['hits'],project)
        checks.append({'repeat':entry['repeat'],'index':entry['index'],'matches':paths==expected})
    return checks
