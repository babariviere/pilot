#!/usr/bin/env bash
# Run the already installed workspace compiler, never a package manager.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
compiler="$root/node_modules/.bin/tsgo"
if [[ ! -x "$compiler" ]]; then
	echo 'typecheck.sh: workspace node_modules/.bin/tsgo is missing; prepare the pinned dependency tree separately' >&2
	exit 127
fi
cd "$root"
exec "$compiler" -p tsconfig.json "$@"
