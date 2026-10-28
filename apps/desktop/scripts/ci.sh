#!/usr/bin/env bash
# Source/fixture CI. Never signs, publishes, installs or launches against user data.
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

# The updater has its own workspace/lockfile. Always name its real manifest;
# the desktop workspace alone does not register or execute these tests.
updater=(--manifest-path updater/Cargo.toml)
# cargo-nextest (installed by bootstrap) runs each libtest test in its own process.
# --no-tests=fail turns an empty selection into a failure instead of a silent pass.
nextest() { cargo nextest run --locked --profile ci --no-tests=fail "$@"; }
updater_test() { nextest "${updater[@]}" --lib "$@"; }

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
    # Patched GPUI sources are path dependencies, so Cargo fingerprints them by
    # mtime. Fixed mtimes let the dependency cache (keyed by patch specs) reuse them.
    python3 - <<'PY'
import os, pathlib
for path in pathlib.Path('.patched').rglob('*'):
    os.utime(path, (1700000000, 1700000000), follow_symlinks=False)
PY
    ;;
  cache-prune)
    # Keep third-party dependency outputs only; workspace crates and test binaries rebuild.
    profile=target/dev/debug
    if [[ -d "$profile" ]]; then
      rm -rf "$profile/incremental" "$profile/examples" "$profile"/.fingerprint/pilot-* "$profile"/build/pilot-*
      find "$profile" -maxdepth 1 -type f -delete
      find "$profile/deps" -maxdepth 1 -type f \( -name 'pilot_*' -o -name 'libpilot_*' -o ! -name '*.*' \) -delete
      du -sh "$profile"
    fi
    ;;
  check)
    host
    cargo fmt --all -- --check
    # Build the real production app/helper, not a copied portable-core fixture.
    cargo build --locked --workspace --bins
    cargo clippy --locked --workspace --all-targets --features native-probes -- -D warnings
    # The helper's tests are macOS-only, so an empty Linux selection is expected here.
    cargo nextest run --locked --profile ci --no-tests=warn -p pilot-visual-worker --bin pilot-visual-worker
    # Library suite plus the auto-discovered path-import harness settings_state (not part of --lib).
    nextest -p pilot-desktop --lib --test settings_state
    python3 -m unittest discover -s scripts -p 'test_*.py' -v
    ;;
  linux-gui-check)
    [[ "$(uname -s):$(uname -m)" == Linux:x86_64 ]] || {
      echo 'Linux GUI fixture checks require native Linux x86_64.' >&2; exit 1;
    }
    # Uses the debug binaries already built by check. No duplicate Cargo build.
    mkdir -p target
    python3 scripts/linux_gui_package_native.py --binaries target/dev/debug \
      --source "${GITHUB_SHA:?Exact tested source required}" \
      --output target/ci-linux-gui-fixture.json
    cat target/ci-linux-gui-fixture.json
    ;;
  updater-check)
    host
    mkdir -p target
    echo 'Standalone updater portable checks started (not Linux installer support).'
    cargo fmt "${updater[@]}" --all -- --check
    cargo clippy --locked "${updater[@]}" --all-targets -- -D warnings
    cargo test --locked "${updater[@]}" --lib -- --list > target/ci-updater-portable-tests.txt
    grep -Fqx 'owned_tests::signature_verifies_exact_bytes_and_key_not_a_nearby_checksum: test' target/ci-updater-portable-tests.txt || {
      echo 'Missing required standalone updater core test.' >&2; exit 1;
    }
    updater_test
    ;;
  updater-linux-tests)
    [[ "$(uname -s):$(uname -m)" == Linux:x86_64 ]] || {
      echo 'Linux updater checks require native Linux x86_64.' >&2; exit 1;
    }
    cargo clippy --locked "${updater[@]}" --all-targets --features native-linux -- -D warnings
    cargo build --locked "${updater[@]}" --features native-linux --bin pilot-desktop-update-helper
    updater_test --features native-linux
    ;;
  updater-mac-tests)
    macos_host
    mkdir -p target
    echo 'Standalone updater macOS Security/ACL/stage/swap/helper checks started.'
    cargo clippy --locked "${updater[@]}" --all-targets --features native-macos -- -D warnings
    cargo build --locked "${updater[@]}" --features native-macos --bin pilot-desktop-update-helper
    # Run OS-bound tests independently of Metal availability. Common lifecycle
    # tests run here too because their fixture/platform paths differ on macOS.
    updater_native_tests=(
      staging_keeps_installed_app_unchanged_and_holds_permanent_target_lock
      ordinary_quit_eof_never_commits_or_replaces_the_bundle
      explicit_commit_is_durable_but_does_not_replace_a_living_parent
      native_atomic_swap_retains_old_bundle_and_requires_startup_ack
      failed_launch_retains_both_bundles_and_refuses_blind_second_swap
      failed_swap_and_post_stage_tampering_leave_installed_bundle_unchanged
      os_exit_monitor_observes_only_real_owned_child_exit_and_never_kills_it
      writable_installation_parent_is_rejected_without_touching_target
      target_inode_is_rechecked_after_long_signature_and_extraction_work
      fast_startup_acknowledgement_is_never_overwritten_by_helper
      helper_status_monitor_reports_abort_and_lost_ack_without_polling
      lost_commit_ack_does_not_undo_durable_intent
      helper_expiry_and_death_cannot_leave_false_ready_or_authorized_status
      stopped_is_terminal_even_for_a_captured_helper_death_event
      macos_acl_write_grants_are_refused_even_with_safe_posix_mode
      nested_installed_file_acl_cannot_race_verified_helper_or_bundle_contents
      newly_created_private_stage_strips_inherited_acl_grants
      existing_object_without_extended_acl_is_not_a_missing_path
      retained_transaction_bound_and_unpublished_cleanup_never_erase_ready_state
      actual_security_framework_validates_whole_temporary_bundle_identity_version_and_tampering
    )
    cargo test --locked "${updater[@]}" --lib --features native-macos -- --list > target/ci-updater-macos-tests.txt
    for test in "${updater_native_tests[@]}"; do
      grep -Fqx "owned_tests::$test: test" target/ci-updater-macos-tests.txt || {
        echo "Missing required macOS updater test: $test" >&2; exit 1;
      }
    done
    # The complete native lib covers the required tests above plus the integrated
    # capsule/reservation modules. Serial, since these share OS-level fixtures.
    updater_test --features native-macos --test-threads=1
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
    'rustc': command('rustc', '-vV'),
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
      visual_runtime::tests::restart_fence_reserves_all_capacity_and_releases_it_on_cancel
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
    filter=()
    for test in "${tests[@]}"; do
      grep -Fqx "$test: test" target/ci-macos-tests.txt || {
        echo "Missing required macOS test: $test" >&2; exit 1;
      }
      filter+=("test(=$test)")
    done
    # One serial run of exactly these tests (they own helper processes and sandboxes).
    nextest -p pilot-desktop --lib --test-threads=1 -E "$(IFS='|'; echo "${filter[*]}")"
    ;;
  native)
    macos_host
    mkdir -p target
    status="$root/target/ci-native-status.txt"
    echo 'Native capability/probes started; no success recorded.' > "$status"
    trap 'code=$?; if [[ $code -ne 0 ]]; then echo "FAILED (exit $code), not skipped/passed" >> "$status"; fi' EXIT
    # Compile every ordinary probe even on hosts without a Metal device.
    tests=(rendering chrome visuals disclosure style icons motion controls history shell navigation inbox jump workbench glass catalog settings dogfooding_diagnostics mission project_creation missions project_add scoped_models artifact_images artifact_gallery inline_visual delivery_diagnostics mission_inspector chat_actions questions mission_tasks composer_controls mission_activity mission_brief mission_task_create mission_update fonts mission_create chat_rename task_status mission_metadata session_failure context_usage task_model task_edit conversation_links mission_lifecycle usage_overview provider_usage workspace_changes session_file_view conversation_images queued_message mission_decisions transcript_find session_todos tool_diff_preview message_fold message_footer new_chat_view path_completion native_mermaid chart_keyboard mission_comments side_panel)
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
  *) echo 'Usage: ci.sh {changed|host|bootstrap|check|linux-gui-check|updater-check|updater-linux-tests|updater-mac-tests|build|artifact|mac-tests|native}' >&2; exit 2 ;;
esac
