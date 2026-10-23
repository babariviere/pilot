#!/usr/bin/env bash
# Source-only CI. Never signs, bundles, publishes, installs or launches the app.
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"
export RUSTUP_HOME="$root/.tools/rustup" RUSTUP_TOOLCHAIN=1.98.1
export PATH="$root/.tools/bin:$HOME/.cargo/bin:$PATH"
export MACOSX_DEPLOYMENT_TARGET=15.0

host() {
  [[ "$(uname -s):$(uname -m)" == Darwin:arm64 ]] || {
    echo 'Desktop Rust CI requires macOS Apple Silicon; no Intel/Linux claim.' >&2; exit 1;
  }
  [[ "$(sw_vers -productVersion | cut -d. -f1)" -ge 15 ]]
  xcrun --show-sdk-version
}
cargo() { bash scripts/cargo.sh "$@"; }

case "${1:-}" in
  host) host ;;
  bootstrap)
    host
    bash scripts/bootstrap.sh
    python3 scripts/prepare-visual-worker.py
    rustc -vV
    .tools/bin/mbx --version
    ;;
  check)
    host
    cargo fmt --all -- --check
    # The library's runtime/confinement tests need the real sibling helper.
    cargo build --locked -p pilot-visual-worker
    cargo clippy --locked --workspace --all-targets --features native-probes -- -D warnings
    cargo test --locked -p pilot-visual-worker --bin pilot-visual-worker -- --test-threads=1
    cargo test --locked -p pilot-desktop --lib -- --test-threads=1
    python3 -m unittest discover -s scripts -p 'test_*.py' -v
    ;;
  build)
    host
    # No test-support/native-probes feature in these normal optimized binaries.
    cargo build --locked --release --workspace --bins
    ;;
  artifact)
    host
    : "${DESKTOP_CI_OUTPUT:?Set a fresh output directory outside the checkout}"
    # Refuse stale contents, including artifacts from a failed previous build.
    mkdir "$DESKTOP_CI_OUTPUT"
    for binary in pilot-desktop pilot-visual-worker; do
      source="target/dev/release/$binary"
      [[ "$(lipo -archs "$source")" == arm64 ]]
      install -m 755 "$source" "$DESKTOP_CI_OUTPUT/$binary"
    done
    python3 - "$DESKTOP_CI_OUTPUT" <<'PY'
import hashlib, json, os, pathlib, re, subprocess, sys, tomllib
def command(*args):
    return subprocess.check_output(args, text=True).strip()
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
tested = command('git', 'rev-parse', 'HEAD')
if tested != os.environ['GITHUB_SHA'] or not re.fullmatch('[0-9a-f]{40}', tested):
    raise SystemExit('Checkout does not match tested GITHUB_SHA')
head = os.environ.get('PR_HEAD_SHA') or None
if head is not None and not re.fullmatch('[0-9a-f]{40}', head):
    raise SystemExit('Invalid PR head SHA')
output = pathlib.Path(sys.argv[1])
packages = [('pilot-desktop', pathlib.Path('Cargo.toml')),
            ('pilot-visual-worker', pathlib.Path('visual-worker/Cargo.toml'))]
manifest = {
    'schema': 1, 'kind': 'unsigned-ci-executables', 'installable_update': False,
    'tested_sha': tested, 'pr_head_sha': head,
    'source_tree': command('git', 'rev-parse', 'HEAD^{tree}'),
    'target': 'aarch64-apple-darwin', 'deployment_target': '15.0',
    'profile': 'release', 'features': [],
    'rustc': command('rustc', '-vV'), 'mbx': command('.tools/bin/mbx', '--version'),
    'sdk_version': command('xcrun', '--show-sdk-version'),
    'xcode': command('xcodebuild', '-version'),
    'lock_sha256': digest(pathlib.Path('Cargo.lock')),
    'binaries': [dict(name=name, version=tomllib.loads(path.read_text())['package']['version'],
                      sha256=digest(output / name), bytes=(output / name).stat().st_size)
                 for name, path in packages],
    'native_verification': 'see separate desktop-rust-native-status artifact; not implied by build',
}
(output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest, indent=2))
PY
    ;;
  native)
    host
    mkdir -p target
    status="$root/target/ci-native-status.txt"
    echo 'Native capability/probes started; no success recorded.' > "$status"
    trap 'code=$?; if [[ $code -ne 0 ]]; then echo "FAILED (exit $code), not skipped/passed" >> "$status"; fi' EXIT
    # Compile every ordinary probe even on hosts without a Metal device.
    tests=(rendering chrome visuals disclosure style icons motion controls history shell navigation inbox jump workbench)
    args=()
    for test in "${tests[@]}"; do args+=(--test "$test"); done
    cargo test --locked --features native-probes --no-run "${args[@]}"
    # Hosted VMs may have no Metal device. Only that precise capability absence
    # is unsupported. Compiler errors, crashes and probe assertions remain failures.
    cat > target/ci-metal.m <<'OBJC'
#import <Metal/Metal.h>
int main(void) {
    @autoreleasepool { return MTLCreateSystemDefaultDevice() == nil ? 78 : 0; }
}
OBJC
    xcrun clang -fobjc-arc -framework Foundation -framework Metal target/ci-metal.m -o target/ci-metal
    capability=0
    target/ci-metal || capability=$?
    if [[ "$capability" == 78 ]]; then
      echo 'UNSUPPORTED: no Metal device. Native probes compiled/linted, NOT executed or passed.' | tee "$status"
      echo '::warning::No Metal device. Rust build/library checks do not establish native renderer support.'
    elif [[ "$capability" != 0 ]]; then
      echo "Metal capability check failed ($capability)." >&2
      exit "$capability"
    else
      echo 'Metal device available; executing synthetic offscreen probes.' > "$status"
      for test in "${tests[@]}"; do
        echo "Running $test" | tee -a "$status"
        cargo test --locked --features native-probes --test "$test"
      done
      echo 'PASSED: synthetic offscreen native probes. Not visible motion/OS IME/performance acceptance.' | tee -a "$status"
    fi
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
      { echo '### Rust desktop native coverage'; cat "$status"; } >> "$GITHUB_STEP_SUMMARY"
    fi
    ;;
  *) echo 'Usage: ci.sh {host|bootstrap|check|build|artifact|native}' >&2; exit 2 ;;
esac
