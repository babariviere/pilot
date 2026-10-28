"""Summarize local probe output. Different timing boundaries stay separate."""
import json
from pathlib import Path

output = Path(__file__).with_name("output")
for name in ("nsh-bench", "gpui-probe", "nsh-probe"):
    path = output / f"{name}.json"
    if not path.exists():
        continue
    report = json.loads(path.read_text())
    print(name, "visible:", report.get("visible", "not recorded"))
    for check in report.get("checks", []):
        print("  PASS" if check["pass"] else "  GAP", check["check"])
    for run in report["runs_including_warmup"][1:]:
        if "draw_only_samples" in run:
            samples = sorted(x["draw_wall_ms"] for x in run["draw_only_samples"])
            print("  draw-only p50/p95/max ms:", *(round(samples[i], 3) for i in (49, 94, 99)))
        else:
            print("  NSH main work ms:", run["main_work_ms"], "completed:", run["completed"])
    samples = report.get("native_editor_to_rust_callback_ms_while_streaming", [])
    if samples:
        samples.sort()
        print("  native edit-to-Rust callback p50/p95/max ms:", *(round(samples[i], 3) for i in (9, 18, 19)))

for name in ("nsh-bench-resources", "gpui-resources"):
    path = output / f"{name}.json"
    if not path.exists():
        continue
    report = json.loads(path.read_text())
    samples = report["samples"]
    first, last = samples[0], samples[-1]
    print(name, report["metric"])
    print("  total mean CPU %:", round(100 * (last["cpu_ms"] - first["cpu_ms"]) / (last["at_ms"] - first["at_ms"]), 1))
    print("  sampled peak footprint MiB:", round(max(s["footprint_bytes"] for s in samples) / 2**20, 1))
