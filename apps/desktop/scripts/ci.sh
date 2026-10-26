#!/usr/bin/env bash
# Source-only CI. Never signs, bundles, publishes, installs or launches the app.
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"
export RUSTUP_HOME="$root/.tools/rustup" RUSTUP_TOOLCHAIN=1.98.1
export PATH="$root/.tools/bin:$HOME/.cargo/bin:$PATH"
export MACOSX_DEPLOYMENT_TARGET=15.0

macos_host() {
  [[ "$(uname -s):$(uname -m)" == Darwin:arm64 ]] || {
    echo 'Desktop Rust CI requires macOS Apple Silicon; no Intel/Linux claim.' >&2; exit 1;
  }
  # Apple's Bash 3.2 does not apply errexit to bare [[ ... ]] commands.
  [[ "$(sw_vers -productVersion | cut -d. -f1)" -ge 15 ]] || {
    echo 'Desktop Rust CI requires macOS 15 or newer.' >&2; exit 1;
  }
  xcrun --show-sdk-version
}
host() {
  case "$(uname -s):$(uname -m)" in
    Linux:x86_64) echo 'Rust test target: x86_64-unknown-linux-gnu (not a desktop release)' ;;
    Darwin:arm64) macos_host ;;
    *) echo 'Unsupported Rust CI host: Ubuntu x86_64 or macOS arm64 required.' >&2; exit 1 ;;
  esac
}
cargo() { bash scripts/cargo.sh "$@"; }

case "${1:-}" in
  changed)
    # PR merge first parent is its base. Main/unknown diffs fail open to checks.
    python3 - <<'PY'
import fnmatch, os, subprocess
def is_input(path):
    if path.startswith('apps/desktop/evidence/'):
        return False
    roots = ('apps/desktop/', 'apps/macos/Sources/PilotVisualEngine/',
             'packages/artifacts/src/visual/', 'packages/protocol/fixtures/visual/', '.cargo/')
    workflows = {'.github/workflows/tests.yaml', '.github/workflows/pr.yaml',
                 '.github/workflows/main.yaml', '.github/workflows/desktop-rust.yml'}
    return (path.startswith(roots) or path in workflows or
            ('/' not in path and (fnmatch.fnmatchcase(path, 'Cargo.*') or
                                  fnmatch.fnmatchcase(path, 'rust-toolchain*'))))
changed = True
if os.environ.get('GITHUB_EVENT_NAME') == 'pull_request':
    try:
        files = subprocess.check_output(['git', 'diff', '--name-only', '-z', 'HEAD^1', 'HEAD'])
        changed = any(is_input(p) for p in os.fsdecode(files).split('\0') if p)
    except subprocess.CalledProcessError:
        pass
value = str(changed).lower()
print(f'Rust checks: {value}')
with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
    output.write(f'rust={value}\n')
PY
    ;;
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
    # Build the real production app/helper, not a copied portable-core fixture.
    cargo build --locked --workspace --bins
    cargo clippy --locked --workspace --all-targets --features native-probes -- -D warnings
    cargo test --locked -p pilot-visual-worker --bin pilot-visual-worker -- --test-threads=1
    cargo test --locked -p pilot-desktop --lib -- --test-threads=1
    # Auto-discovered path-import integration harness, not part of --lib.
    cargo test --locked -p pilot-desktop --test settings_state -- --test-threads=1
    python3 -m unittest discover -s scripts -p 'test_*.py' -v
    ;;
  build)
    macos_host
    # No test-support/native-probes feature in these normal optimized binaries.
    cargo build --locked --release --workspace --bins
    ;;
  artifact)
    macos_host
    : "${DESKTOP_CI_OUTPUT:?Set a fresh output directory outside the checkout}"
    # Refuse stale contents, including artifacts from a failed previous build.
    mkdir "$DESKTOP_CI_OUTPUT"
    for binary in pilot-desktop pilot-visual-worker; do
      source="target/dev/release/$binary"
      [[ "$(lipo -archs "$source")" == arm64 ]] || {
        echo "Refusing non-arm64 CI artifact: $binary" >&2; exit 1;
      }
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
  mac-tests)
    macos_host
    cargo build --locked -p pilot-visual-worker
    mkdir -p target
    # These existing tests are #[cfg(target_os = "macos")]. Never rerun the
    # portable library suite here or silently succeed with a zero-test filter.
    tests=(
      visual_runtime::tests::shared_draw_errors_match_without_relaxing_the_production_budget
      visual_runtime::tests::native_canvas_packets_match_shared_commands_ops_and_strings
      visual_runtime::tests::shared_api_one_view_event_and_state_corpus_matches_the_native_worker
      visual_runtime::tests::real_sandbox_load_event_and_oom_null_discard
      visual_runtime::tests::stopped_owned_worker_hits_parent_hard_deadline_and_is_killed_reaped
      visual_session::tests::failed_handler_state_is_not_committed_and_retry_has_a_fresh_vm
      visual_session::tests::draw_interrupt_or_null_error_discards_vm_and_keeps_committed_state
      artifact_worker::tests::explicit_scoped_read_and_event_use_only_faux_gets_and_close_reaps
    )
    cargo test --locked -p pilot-desktop --lib -- --list > target/ci-macos-tests.txt
    for test in "${tests[@]}"; do
      grep -Fqx "$test: test" target/ci-macos-tests.txt || {
        echo "Missing required macOS test: $test" >&2; exit 1;
      }
      cargo test --locked -p pilot-desktop --lib "$test" -- --exact --test-threads=1
    done
    ;;
  native)
    macos_host
    mkdir -p target
    status="$root/target/ci-native-status.txt"
    echo 'Native capability/probes started; no success recorded.' > "$status"
    trap 'code=$?; if [[ $code -ne 0 ]]; then echo "FAILED (exit $code), not skipped/passed" >> "$status"; fi' EXIT
    # Compile every ordinary probe even on hosts without a Metal device.
    tests=(rendering chrome visuals disclosure style icons motion controls history shell navigation inbox jump workbench catalog settings mission project_creation missions project_add scoped_models artifact_images artifact_gallery delivery_diagnostics mission_inspector chat_actions questions mission_tasks composer_controls)
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
  *) echo 'Usage: ci.sh {changed|host|bootstrap|check|build|artifact|mac-tests|native}' >&2; exit 2 ;;
esac
