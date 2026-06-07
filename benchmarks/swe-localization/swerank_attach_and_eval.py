#!/usr/bin/env python3
"""
Attach mimirs rankings to SweRank's dataset and run their localization eval.

Bridges `swerank-adapter.ts` (mimirs retrieval -> {instance_id: [doc_id,...]})
into SweRank's own `refactored_eval_localization.py`, so the file/module/function
recall@k numbers are computed by THEIR scorer — apples-to-apples with their paper
leaderboard. See plans/external-benchmarks-survey.md.

Run from inside the SweRank repo checkout (so `src/` is importable):
    PYTHONPATH=src python /path/to/swerank_attach_and_eval.py \
        <mimirs_topdocs.json> <dataset> <datasets_dir> [model_tag] [output_dir]

  dataset      = swe-bench-lite | loc-bench
  datasets_dir = the unzipped SweRank `datasets/` folder
  model_tag    = label for outputs (default: mimirs)
"""
import json
import os
import subprocess
import sys

from datasets import load_dataset

HF_NAME = {
    "swe-bench-lite": ("princeton-nlp/SWE-bench_Lite", "test"),
    "loc-bench": ("czlll/Loc-Bench_V1", "test"),
}


def main():
    topdocs_path = sys.argv[1]
    dataset = sys.argv[2]
    datasets_dir = sys.argv[3]
    model_tag = sys.argv[4] if len(sys.argv) > 4 else "mimirs"
    output_dir = sys.argv[5] if len(sys.argv) > 5 else "./outputs"
    os.makedirs(output_dir, exist_ok=True)

    with open(topdocs_path) as f:
        topdocs = json.load(f)

    hf_name, split = HF_NAME[dataset]
    ds = load_dataset(hf_name)[split]

    # Align ranked docs to dataset row order, exactly as eval_beir_sbert_canonical
    # does (default [] for instances we didn't rank).
    docs_col = [topdocs.get(ex["instance_id"], []) for ex in ds]
    covered = sum(1 for d in docs_col if d)
    print(f"Attached rankings for {covered}/{len(ds)} instances.")
    ds = ds.add_column("docs", docs_col)

    results_file = os.path.join(output_dir, f"model={model_tag}_dataset={dataset}_results.json")
    ds.to_json(results_file)
    print(f"Wrote docs-annotated dataset -> {results_file}")

    # Hand off to SweRank's own localization scorer (file/module/function recall@k).
    cmd = [
        sys.executable, "src/refactored_eval_localization.py",
        "--model", model_tag,
        "--output_dir", output_dir,
        "--dataset_dir", datasets_dir,
        "--output_file", results_file,
        "--dataset", dataset,
    ]
    print("Running:", " ".join(cmd))
    subprocess.run(cmd, check=True)


if __name__ == "__main__":
    main()
