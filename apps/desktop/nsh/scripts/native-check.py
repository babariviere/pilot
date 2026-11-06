"""Hidden AppKit chat checks. No live daemon, account, display activation or benchmark."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    for appearance in ("light", "dark"):
        for width in (1180, 680):
            with tempfile.TemporaryDirectory(prefix="nsh-native-chat-") as temporary:
                state = Path(temporary) / "profile"
                capture = args.output.resolve() / f"{appearance}-{width}.png"
                command = [str(args.binary.resolve()), "--fixture", "--state-dir", str(state),
                           "--width", str(width), "--capture", str(capture)]
                if appearance == "dark":
                    command.append("--dark")
                subprocess.run(command, check=True, timeout=60)
                assert capture.stat().st_size > 10000, f"missing native capture: {capture}"
                book = json.loads((state / "state-v1.json").read_text())
                assert book["drafts"]["chat:b"]["text"] == "independent draft\n保持"
                assert not book["pending"], "normal Send and Stop need exact settlement"
                restart = args.output.resolve() / f"{appearance}-{width}-restart.png"
                resumed = command.copy()
                resumed[resumed.index("--capture") + 1] = str(restart)
                resumed.append("--check-saved-draft")
                subprocess.run(resumed, check=True, timeout=60)
                assert restart.stat().st_size > 10000
                print(f"PASS {appearance} {width}: native edit/selection/undo/drafts/Send/Stop/Close")
            with tempfile.TemporaryDirectory(prefix="nsh-native-prompts-") as temporary:
                state = Path(temporary) / "profile"
                capture = args.output.resolve() / f"{appearance}-{width}-question.png"
                command = [str(args.binary.resolve()), "--fixture", "--check-prompts",
                           "--state-dir", str(state), "--width", str(width), "--capture", str(capture)]
                if appearance == "dark":
                    command.append("--dark")
                subprocess.run(command, check=True, timeout=60)
                for path in (capture, capture.with_stem(capture.stem + "-read"),
                             capture.with_stem(capture.stem + "-write")):
                    assert path.stat().st_size > 10000, f"missing prompt capture: {path}"
                book = json.loads((state / "state-v1.json").read_text())
                assert book["drafts"]["chat:a"]["text"] == "ordinary draft\n保持"
                assert not book["pending"]
                assert book["drafts"]["chat:a"].get("answer") is None
                print(f"PASS {appearance} {width}: native question/choices/Allow/Deny/drafts/Stop/Close")


if __name__ == "__main__":
    main()
