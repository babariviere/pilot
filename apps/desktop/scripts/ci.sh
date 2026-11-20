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
    echo 'Native helper CI requires macOS Apple Silicon; no Intel/Linux claim.' >&2; exit 1;
  }
  # Apple's Bash 3.2 does not apply errexit to bare [[ ... ]] commands.
  [[ "$(sw_vers -productVersion | cut -d. -f1)" -ge 15 ]] || {
    echo 'Native helper CI requires macOS 15 or newer.' >&2; exit 1;
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
# the visual-worker workspace does not register or execute these tests.
updater=(--manifest-path updater/Cargo.toml)
# cargo-nextest (installed by bootstrap) runs each libtest test in its own process.
# --no-tests=fail turns an empty selection into a failure instead of a silent pass.
nextest() { cargo nextest run --locked --profile ci --no-tests=fail "$@"; }
updater_test() { nextest "${updater[@]}" --lib "$@"; }

case "${1:-}" in
  host) host ;;
  power-check)
    host
    # Linux uses only private fake D-Bus services, never the user's power services.
    bash ../power/scripts/cargo.sh fmt -- --check
    bash ../power/scripts/cargo.sh clippy --locked --all-targets -- -D warnings
    bash ../power/scripts/cargo.sh test --locked
    bash ../power/scripts/cargo.sh build --locked
    ;;
  bootstrap)
    host
    bash scripts/bootstrap.sh
    ;;
  visual-check)
    host
    python3 scripts/prepare-visual-worker.py
    cargo fmt --all -- --check
    cargo clippy --locked -p pilot-visual-worker --all-targets -- -D warnings
    cargo build --locked -p pilot-visual-worker --bin pilot-visual-worker
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
    # Run the common lifecycle tests, too: their fixture paths differ on macOS.
    updater_native_tests=(
      staging_keeps_installed_app_unchanged_and_holds_permanent_target_lock
      macos_staging_never_exposes_intermediate_apps_beside_installation
      temporary_payload_handoff_survives_worker_drop_and_relocated_target
      purged_temporary_payload_never_replays_committed_install_or_loses_recovery
      failed_download_cleans_only_its_exact_private_temporary_workspace
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
      local_signed_source_stages_then_normal_release_verification_still_works
      prepared_payload_moves_extraction_before_commit_but_never_trusts_mutable_staging
      prepared_payload_cancellation_can_retry_but_commit_never_discards_evidence
      prepared_payload_still_requires_commit_and_fresh_post_exit_guard
      interrupted_disposable_preparation_is_never_adopted_as_a_ready_payload
      temporary_cleanup_follows_relaunch_and_recovers_without_replaying_installation
      final_candidate_sync_failure_never_advances_the_journal_or_swaps
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
  *) echo 'Usage: ci.sh {host|bootstrap|visual-check|power-check|updater-check|updater-linux-tests|updater-mac-tests}' >&2; exit 2 ;;
esac
