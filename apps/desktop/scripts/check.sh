#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 scripts/prepare-visual-worker.py
bash scripts/cargo.sh build --locked -p pilot-visual-worker
bash scripts/cargo.sh fmt --all -- --check
bash scripts/cargo.sh clippy -p pilot-visual-worker --locked --all-targets -- -D warnings
bash scripts/cargo.sh clippy --all-targets --locked -- -D warnings
bash scripts/cargo.sh test --lib --locked -- --test-threads=1
# Pure preferences validation/durability, path-import harness, no production state.
bash scripts/cargo.sh test --test settings_state --locked -- --test-threads=1
# Native offscreen renderer, not a visible app or scrolling benchmark.
bash scripts/cargo.sh test --test rendering --locked
bash scripts/cargo.sh test --test chrome --locked
bash scripts/cargo.sh test --test visuals --locked
# Synthetic production-root multi-frame disclosure/activity regression only.
bash scripts/cargo.sh clippy --locked --features native-probes --test disclosure -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test disclosure
# Native production-root rounded geometry, motion, cancellation and cached-history checks.
bash scripts/cargo.sh clippy --locked --features native-probes --test style -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test style
# Actual SVG paint and mounted bounds, not just catalog names.
bash scripts/cargo.sh clippy --locked --features native-probes --test icons -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test icons
bash scripts/cargo.sh clippy --locked --features native-probes --test motion -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test motion
# Actual native gestures over a faux isolated-reader channel, never Local actions.
bash scripts/cargo.sh clippy --locked --features native-probes --test controls -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test controls
# Real top scroll/selection with faux paged reads, never a real Local action.
bash scripts/cargo.sh clippy --locked --features native-probes --test history -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test history
# Actual Home/projects/chat navigation with synthetic summaries/faux channels only.
bash scripts/cargo.sh clippy --locked --features native-probes --test shell -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test shell
# Bounded destination/scope state, fake read channel, no replay of actions.
bash scripts/cargo.sh clippy --locked --features native-probes --test navigation -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test navigation
# Read-only partial Inbox with native filtering, faux reads and no action replay.
bash scripts/cargo.sh clippy --locked --features native-probes --test inbox -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test inbox
# Ephemeral bounded resource palette, faux reads and no action replay.
bash scripts/cargo.sh clippy --locked --features native-probes --test jump -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test jump
# Same-fixture shell hierarchy and native chooser reachability/IME checks.
bash scripts/cargo.sh clippy --locked --features native-probes --test workbench -- -D warnings
env -u PILOT_NEXT_WORKBENCH_BASELINE bash scripts/cargo.sh test --locked --features native-probes --test workbench
# Reusable presentation contracts with actual Kit controls, synthetic state only.
bash scripts/cargo.sh clippy --locked --features native-probes --test catalog -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test catalog
# Actual Settings window/Appearance preferences, private fixtures and guarded entry only.
bash scripts/cargo.sh clippy --locked --features native-probes --test settings -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test settings
bash scripts/cargo.sh clippy --locked --features native-probes --test fonts -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test fonts
# Existing-chat conversion with an owned faux HTTP daemon and private writer.
bash scripts/cargo.sh clippy --locked --features native-probes --test mission -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test mission

# Actual project choice and durable create over an owned faux daemon.
bash scripts/cargo.sh test --locked --features native-probes --test project_creation
# Read-only global mission discovery and existing-chat navigation, owned faux HTTP only.
bash scripts/cargo.sh test --locked --features native-probes --test missions
bash scripts/cargo.sh test --locked --features native-probes --test project_add
# Explicit Local global model scope, owned faux HTTP/native capability only.
bash scripts/cargo.sh test --locked --features native-probes --test scoped_models
# Stored raster reader/pane against owned faux HTTP; no real Local data or actions.
bash scripts/cargo.sh clippy --locked --features native-probes --test artifact_images -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test artifact_images
# Exact stored conversation blocks, owned faux Local and offscreen native painting.
bash scripts/cargo.sh clippy --locked --features native-probes --test conversation_images -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test conversation_images
bash scripts/cargo.sh clippy --locked --features native-probes --test artifact_gallery -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test artifact_gallery
bash scripts/cargo.sh clippy --locked --features native-probes --test delivery_diagnostics -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test delivery_diagnostics
bash scripts/cargo.sh clippy --locked --features native-probes --test mission_inspector -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test mission_inspector
# Exact row menus, synthetic Local archive/restore and confirmed conversion only.
bash scripts/cargo.sh clippy --locked --features native-probes --test chat_actions -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test chat_actions
bash scripts/cargo.sh clippy --locked --features native-probes --test questions -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test questions

bash scripts/cargo.sh clippy --locked --features native-probes --test mission_tasks -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test mission_tasks

# Contextual composer controls, synthetic only.
bash scripts/cargo.sh clippy --locked --features native-probes --test composer_controls -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test composer_controls
# Bounded read-only mission activity.
bash scripts/cargo.sh clippy --locked --features native-probes --test mission_activity -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test mission_activity
bash scripts/cargo.sh clippy --locked --features native-probes --test mission_brief -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test mission_brief
bash scripts/cargo.sh clippy --locked --features native-probes --test mission_task_create -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test mission_task_create
bash scripts/cargo.sh clippy --locked --features native-probes --test task_status -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test task_status
bash scripts/cargo.sh clippy --locked --features native-probes --test mission_update -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test mission_update

bash scripts/cargo.sh clippy --locked --features native-probes --test mission_metadata -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test mission_metadata
bash scripts/cargo.sh clippy --locked --features native-probes --test session_failure -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test session_failure
