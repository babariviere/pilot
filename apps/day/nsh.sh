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
	echo 'nsh.sh: longbridge/nsh 0.5.0 is missing; set NSH_DAY_CLI to its installed executable' >&2
	exit 127
fi
cli="$(cd "$(dirname "$cli")" && pwd)/$(basename "$cli")"
version="$("$cli" --version)"
if [[ "$version" != 'nsh 0.5.0 (f4d68f7)' ]]; then
	echo 'nsh.sh: expected longbridge/nsh 0.5.0 (f4d68f7); qualify another release before use' >&2
	exit 1
fi
export CARGO="$here/scripts/cargo"
command_index=1
for arg in "$@"; do
	case "$arg" in
		-v|--verbose) command_index=$((command_index + 1)) ;;
		*) break ;;
	esac
done
command="${!command_index:-}"
if [[ "$command" = check ]]; then
	# NSH otherwise downloads its own TypeScript compiler. Do not permit a
	# command-line override to bypass this workspace compiler selection.
	for arg in "${@:command_index+1}"; do
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
case "$command" in
	check|build|test|dev|run|package|publish)
		cargo_version="$("$NSH_DAY_REAL_CARGO" --version)"
		if [[ "$cargo_version" == *'(huacnlee/cargo '* ]]; then
			if [[ -n "${CARGO_TARGET_DIR:-}" ]]; then
				echo 'nsh.sh: use stock Cargo via NSH_DAY_REAL_CARGO to set CARGO_TARGET_DIR.' >&2
				exit 2
			fi
			# NSH 0.5.0 tries CARGO_TARGET_DIR first, then Cargo metadata and
			# the generated workspace's target. Make the first lookup miss so
			# an old app/target never takes precedence over the fork's output.
			export CARGO_TARGET_DIR="$here/.nsh/cargo-fork-target"
			if [[ -e "$CARGO_TARGET_DIR" || -L "$CARGO_TARGET_DIR" ]]; then
				echo "nsh.sh: reserved lookup path must not exist: $CARGO_TARGET_DIR" >&2
				exit 2
			fi
		fi
		# Keep the release's locked transitive selections in fresh generated
		# workspaces. Never overwrite a workspace Cargo already resolved.
		for app in "$here" "$here/fixtures/rust-today"; do
			target="$app/.nsh/rust/target"
			# Unlink the old managed target view, without deleting its cache.
			if [[ -L "$target" && "$(readlink "$target")" == */mbx/targets/v1/* ]]; then
				unlink "$target"
			fi
			lock="$app/.nsh/rust/Cargo.lock"
			if [[ ! -e "$lock" ]]; then
				mkdir -p "$(dirname "$lock")"
				cp "$here/runner.Cargo.lock" "$lock"
			fi
		done
		;;
esac
if [[ "$command" = test ]]; then mkdir -p output; fi
exec "$cli" "$@"
