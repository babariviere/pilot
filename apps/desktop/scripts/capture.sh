#!/usr/bin/env bash
# Opt-in production-view pixels of exactly one requested chat. Private output only.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $# != 1 ]]; then
  echo 'Usage: bash scripts/capture.sh <exact Local chat ID>' >&2; exit 2
fi
umask 077
mkdir -p evidence/local/captures
output="$PWD/evidence/local/captures/ui-$(date +%Y%m%dT%H%M%S).png"
bash scripts/cargo.sh test --test capture --locked -- --chat "$1" --output "$output"
printf 'Private capture: %s\n' "${output#"$PWD"/}"
