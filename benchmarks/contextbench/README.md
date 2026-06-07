# ContextBench harness for mimirs

Evaluate mimirs retrieval against [ContextBench](https://github.com/EuniAI/ContextBench)
— real repos, file/definition/line-span coverage **and precision**. Unlike SweRank
(flat corpus, parked), this exercises the full mimirs pipeline. See
`plans/external-benchmarks-survey.md` for why it fits.

## Pieces
- `prep_tasks.py` — ContextBench parquet → `tasks.jsonl` (instance_id, repo, base_commit, problem_statement). Runs in the ContextBench venv.
- `cb-adapter.ts` — per task: shallow-fetch repo@commit → mimirs index → `searchChunks` → emit unified trajectory `pred.jsonl` (`{instance_id, traj_data:{pred_files, pred_spans}}`). Streams to disk (crash-safe).
- Scoring is ContextBench's own `contextbench.evaluate` — no custom parser needed; it reads the unified `pred.jsonl` directly.

## Run
```bash
# 0. one-time: clone ContextBench + py3.12 venv (tree-sitter-language-pack needs >=3.12)
git clone https://github.com/EuniAI/ContextBench /tmp/ContextBench-spike
cd /tmp/ContextBench-spike && python3.12 -m venv .venv && . .venv/bin/activate
pip install tree-sitter tree-sitter-language-pack pandas pyarrow datasets gitpython

# 1. tasks (sample N)
python /path/to/mimirs/benchmarks/contextbench/prep_tasks.py /tmp/ContextBench-spike /tmp/cb-tasks.jsonl 10

# 2. mimirs trajectories (real clone+index per instance — slow, sample-based)
cd /path/to/mimirs
RAG_DB_DIR=/tmp/cb-db bun benchmarks/contextbench/cb-adapter.ts /tmp/cb-tasks.jsonl /tmp/cb-pred.jsonl 10

# 3. score (clones repos again for gold extraction)
cd /tmp/ContextBench-spike && . .venv/bin/activate
python -m contextbench.evaluate --gold data/contextbench_verified.parquet \
  --pred /tmp/cb-pred.jsonl --cache /tmp/cb-gold-repos --out /tmp/cb-results.jsonl
```

## Output
Per granularity (`file`, `symbol`, `span`, `line`): Coverage (=recall) + Precision,
plus trajectory AUC / Redundancy. **The angle: mimirs returns a focused top-K, so
watch precision** — the paper's finding is agents over-retrieve (high recall, low
precision). Tune focus with `topK` (arg 5 of cb-adapter) and `weight` (arg 6).

## Cost
Real clone + full index per instance (minutes each on CPU) → sample-based, not the
full 1136. `topK` controls the recall/precision trade.
