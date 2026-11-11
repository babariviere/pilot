#!/usr/bin/env bash
# Use an installed longbridge distribution, without rebuilding NSH.
set -euo pipefail
# Child package-manager invocations must not switch versions or run hooks.
export npm_config_manage_package_manager_versions=false
export npm_config_ignore_scripts=true
export NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS=false
export NPM_CONFIG_IGNORE_SCRIPTS=true
export COREPACK_ENABLE_AUTO_PIN=0
export COREPACK_ENABLE_NETWORK=0
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=apps/day/scripts/build-env.sh
source "$here/scripts/build-env.sh"
cli="${NSH_DAY_CLI:-$(command -v nsh || true)}"
if [[ -z "$cli" && -x "$HOME/.nsh/bin/nsh" ]]; then
	cli="$HOME/.nsh/bin/nsh"
fi
if [[ ! -x "$cli" ]]; then
	echo 'nsh.sh: longbridge/nsh 0.4.0 is missing; set NSH_DAY_CLI to its installed executable' >&2
	exit 127
fi
cli="$(cd "$(dirname "$cli")" && pwd)/$(basename "$cli")"
version="$("$cli" --version)"
if [[ "$version" != 'nsh 0.4.0 (e626a8d)' ]]; then
	echo 'nsh.sh: expected longbridge/nsh 0.4.0 (e626a8d); qualify another release before use' >&2
	exit 1
fi
export CARGO="$here/scripts/cargo"
export CARGO_NET_OFFLINE=true
if [[ "${1:-}" = check ]]; then
	# NSH otherwise downloads its own TypeScript compiler. Do not permit a
	# command-line override to bypass this workspace compiler selection.
	for arg in "${@:2}"; do
		[[ "$arg" = -- ]] && break
		if [[ "$arg" = --tsc || "$arg" = --tsc=* ]]; then
			echo 'nsh.sh: --tsc is managed by the wrapper' >&2
			exit 2
		fi
	done
	compiler="$here/../../node_modules/.bin/tsgo"
	if [[ ! -x "$compiler" ]]; then
		echo 'nsh.sh: workspace node_modules/.bin/tsgo is missing; prepare the pinned dependency tree separately' >&2
		exit 127
	fi
	export NSH_TSC="$compiler"
fi
cd "$here"
case "${1:-}" in
	check|build|test|run|package)
		# Keep the release's locked transitive selections in fresh generated
		# workspaces. Never overwrite a workspace Cargo already resolved.
		for app in "$here" "$here/fixtures/rust-today"; do
			lock="$app/.nsh/rust/Cargo.lock"
			if [[ ! -e "$lock" ]]; then
				mkdir -p "$(dirname "$lock")"
				cp "$here/runner.Cargo.lock" "$lock"
			fi
		done
		;;
esac
if [[ "${1:-}" = test ]]; then mkdir -p output; fi
# Runtime execution is local; only nested Cargo uses the mbx adapter.
exec "$cli" "$@"
