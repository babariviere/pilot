"""Hidden native stored-image checks. Synthetic data and private clipboard only."""
import argparse
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
            with tempfile.TemporaryDirectory(prefix="nsh-native-images-") as temporary:
                capture = args.output.resolve() / f"{appearance}-{width}-images.png"
                command = [str(args.binary.resolve()), "--fixture", "--check-images",
                           "--state-dir", str(Path(temporary) / "profile"),
                           "--width", str(width), "--capture", str(capture)]
                if appearance == "dark":
                    command.append("--dark")
                subprocess.run(command, check=True, timeout=90)
                for suffix in ("", "-loading", "-fit", "-zoom", "-pan", "-reset",
                               "-earlier-1", "-earlier-2", "-earlier-3", "-landscape-zoom"):
                    path = capture.with_stem(capture.stem + suffix)
                    assert path.stat().st_size > 10000, f"missing image capture: {path}"
                print(f"PASS {appearance} {width}: inline images/geometry/ownership/Copy/zoom/pan/anchor")


if __name__ == "__main__":
    main()
