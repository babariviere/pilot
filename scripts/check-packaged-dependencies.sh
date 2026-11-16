#!/usr/bin/env bash
# Verify production dependencies after archive relocation, never in the build tree alone.
set -euo pipefail
stage="$(mktemp -d "$RUNNER_TEMP/renovate-runtime.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
apps/macos/scripts/bundle-runtime.sh "$stage/runtime"
ditto -c -k --keepParent "$stage/runtime" "$stage/runtime.zip"
mkdir "$stage/relocated"
ditto -x -k "$stage/runtime.zip" "$stage/relocated"
apps/macos/scripts/check-runtime.sh "$stage/relocated/runtime"
