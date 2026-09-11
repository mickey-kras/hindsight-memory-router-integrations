import os
from pathlib import Path
import subprocess
import sys

import yaml


workflow = Path(__file__).resolve().parents[1] / "workflows/policy-guard.yml"
steps = yaml.safe_load(workflow.read_text())["jobs"]["guard"]["steps"]
source = []
for index, step in enumerate(steps[2:5]):
    operator = ">" if index == 0 else ">>"
    prefix = (
        "set -euo pipefail\n"
        f"cat <<'POLICY_SOURCE' {operator} \"$RUNNER_TEMP/policy_guard.py\"\n"
    )
    run = step["run"]
    if not run.startswith(prefix) or not run.endswith("POLICY_SOURCE\n"):
        raise ValueError("Unexpected trusted policy source")
    source.append(run[len(prefix):-len("POLICY_SOURCE\n")])

fixture = Path(sys.argv[1]).resolve()
subprocess.run(
    [sys.executable, "-c", "".join(source)],
    env={
        **os.environ,
        "FILES_JSON": str(fixture / "files.json"),
        "GUARD_FIXTURE_DIR": str(fixture),
    },
    check=True,
)
