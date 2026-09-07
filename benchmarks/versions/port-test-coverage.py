"""Render the reviewed TS test mapping, including fixture-generated tests.

python3 benchmarks/versions/port-test-coverage.py [--check]
The classifications live in port/test-coverage.json. This script only inventories
the pinned suite, validates the mapping/evidence, and renders the report.
"""

import collections
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PORT = ROOT / "benchmarks/versions/port"
REVISION = "122674c8bfbbc3549390743f51396c5f0e4e3537"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True)


def inventory():
    paths = git("ls-tree", "-r", "--name-only", REVISION, "tests").splitlines()
    reviewed = json.loads((PORT / "source-windows/reference.json").read_text())["cases"]
    rows = []
    for path in paths:
        if not path.endswith(".test.ts"):
            continue
        source = git("show", f"{REVISION}:{path}")
        # This deliberately targets the frozen suite's registration syntax.
        # Fail on new argument forms instead of silently omitting a test.
        calls = list(re.finditer(r"^\s*(?:test|it)(?:\.(?:skip|todo|only))?\s*\(\s*", source, re.M))
        for call in calls:
            line = source[:call.end()].count("\n") + 1
            argument = source[call.end():]
            quoted = re.match(r"(['\"`])(.*?)\1", argument, re.S)
            if quoted:
                title = quoted[2]
                if "${name}" in title:
                    assert path == "tests/source-windows.test.ts"
                    titles = [title.replace("${name}", case["path"].removeprefix("tests/fixtures/source-windows/"))
                              for case in reviewed]
                elif "${label}" in title:
                    assert path == "tests/source-embeddings.test.ts"
                    titles = [title.replace("${label}", label) for label in ("source-name", "labeled source-name")]
                else:
                    assert "${" not in title, (path, line, title)
                    titles = [title]
            elif argument.startswith("fixtureName,"):
                assert path == "tests/chunker.test.ts"
                # The archived extension filter selects exactly these files.
                languages = re.search(r"const LANGUAGES = \[([\s\S]*?)\] as const", source)[1]
                languages = set(re.findall(r'"([^"]+)"', languages))
                titles = [p.removeprefix("tests/fixtures/") for p in paths
                          if p.startswith("tests/fixtures/") and len(p.split("/")) == 4
                          and p.split("/")[2] in languages]
                # Each selected file must have the two goldens used by this test.
                for title in titles:
                    language, name = title.split("/")
                    stem = re.sub(r"(?:\.d)?\.[^.]+$", "", name)
                    assert f"tests/goldens/{language}/{stem}.tree.txt" in paths, title
                    assert f"tests/goldens/source-facts/{language}/{stem}.facts.txt" in paths, title
            elif argument.startswith("projectName,"):
                assert path == "tests/source-relationships.test.ts"
                suites = re.search(r"const SUITES = \[([\s\S]*?)\] as const", source)[1]
                suites = set(re.findall(r'"([^"]+)"', suites))
                titles = sorted({"/".join(p.split("/")[3:5]) for p in paths
                                 if p.startswith("tests/fixtures/projects/") and len(p.split("/")) >= 6
                                 and p.split("/")[3] in suites})
                for title in titles:
                    assert f"tests/goldens/relationships/{title}.txt" in paths, title
            else:
                raise ValueError(f"unrecognized test registration: {path}:{line}")
            rows.extend({"suite": path, "line": line, "title": title} for title in titles)
        assert calls, f"suite without registrations: {path}"
    assert len({row["suite"] for row in rows}) == 52
    return rows


def render():
    mapping = json.loads((PORT / "test-coverage.json").read_text())
    assert mapping["revision"] == REVISION
    rows = inventory()
    assert set(mapping["suites"]) == {row["suite"] for row in rows}
    used = set()
    overrides = set()
    for row in rows:
        suite = mapping["suites"][row["suite"]]
        key = str(row["line"])
        assessment = suite.get("overrides", {}).get(key, suite["default"])
        if key in suite.get("overrides", {}):
            overrides.add((row["suite"], key))
        row["assessment"] = assessment
        used.add(assessment)
    assert overrides == {(suite, line) for suite, value in mapping["suites"].items()
                         for line in value.get("overrides", {})}, "stale test overrides"
    assert used == set(mapping["assessments"]), "unused assessment"
    for assessment in mapping["assessments"].values():
        assert assessment["status"] in ("covered", "missing", "outside scope")
        assert assessment["reason"] and assessment["evidence"]
        for evidence in assessment["evidence"]:
            path, _, function = evidence.partition("::")
            text = (ROOT / path).read_text()
            if function:
                assert re.search(rf"\bfn\s+{re.escape(function)}\b", text), evidence
    counts = collections.Counter(mapping["assessments"][row["assessment"]]["status"] for row in rows)
    output = [
        "# TS v2 test coverage map", "",
        f"Reference revision: `{REVISION}`. This inventories all 52 archived `.test.ts` suites,",
        "including the chunker fixtures, relationship projects, reviewed windows, and two",
        "source-name projection variants registered by loops. It does not count assertion",
        "calls, benchmarks, or the separate `tests/integration/mini-lm-smoke.ts` script.", "",
        f"There are {len(rows)} expanded test cases: {counts['covered']} covered,",
        f"{counts['missing']} missing, and {counts['outside scope']} outside the adopted scope.", "",
        "These counts describe a reviewed correspondence, not a coverage percentage or a",
        "claim of full TS feature parity. Covered means Rust checks the applicable behavior",
        "with the cited assertions. It does not mean every original assertion was copied.",
        "Missing means the TS case has no equivalent regression test demonstrated here;",
        "it does not prove that Rust fails the case. Mixed tests stay missing when an",
        "applicable part lacks coverage. Outside scope includes real feature gaps and",
        "different public contracts, explained below. It does not mean those features",
        "cannot be added. Tests of retired Rust document builders are identified explicitly",
        "and do not establish production input parity.", "",
        "The [coverage review](TEST-COVERAGE.md) explains priorities and limits.",
        "Classifications are maintained in [test-coverage.json](test-coverage.json).",
        "Regenerate with `python3 benchmarks/versions/port-test-coverage.py`; use `--check`",
        "to detect stale inventory, evidence names, or rendered output.", "",
        "| TS suite | Covered | Missing | Outside scope |", "| --- | ---: | ---: | ---: |",
    ]
    grouped = collections.defaultdict(list)
    for row in rows:
        grouped[row["suite"]].append(row)
    for suite, cases in grouped.items():
        counts = collections.Counter(mapping["assessments"][row["assessment"]]["status"] for row in cases)
        output.append(f"| [{Path(suite).name}](#{Path(suite).name.replace('.', '')}) | "
                      f"{counts['covered']} | {counts['missing']} | {counts['outside scope']} |")
    for suite, cases in grouped.items():
        output.extend(["", f"## {Path(suite).name}", ""])
        assessments = list(dict.fromkeys(row["assessment"] for row in cases))
        for key in assessments:
            value = mapping["assessments"][key]
            links = []
            for evidence in value["evidence"]:
                path, _, function = evidence.partition("::")
                label = function or path
                links.append(f"[{label}](../../../{path})")
            output.extend([f"**{key}**: {value['reason']} Evidence: {', '.join(links)}.", ""])
        output.extend(["| TS test | Status | Assessment |", "| --- | --- | --- |"])
        for row in cases:
            url = f"https://github.com/TheWinci/mimirs/blob/{REVISION}/{suite}#L{row['line']}"
            title = row["title"].replace("|", "\\|").replace("\n", " ")
            status = mapping["assessments"][row["assessment"]]["status"]
            output.append(f"| [{title}]({url}) | {status} | {row['assessment']} |")
    return "\n".join(output) + "\n"


if __name__ == "__main__":
    assert sys.argv[1:] in ([], ["--check"])
    result = render()
    path = PORT / "TEST-MAP.md"
    if "--check" in sys.argv:
        assert path.read_text() == result, "stale TEST-MAP.md; regenerate it"
        print("TS test inventory, classifications, evidence, and report are consistent.")
    else:
        path.write_text(result)
        print(path)
