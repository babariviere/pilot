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
cli="${NSH_DAY_CLI:-$(command -v nsh || true)}"
if [[ -z "$cli" && -x "$HOME/.nsh/bin/nsh" ]]; then
	cli="$HOME/.nsh/bin/nsh"
fi
if [[ ! -x "$cli" ]]; then
	echo 'nsh.sh: longbridge/nsh 0.6.1 is missing; set NSH_DAY_CLI to its installed executable' >&2
	exit 127
fi
cli="$(cd "$(dirname "$cli")" && pwd)/$(basename "$cli")"
version="$("$cli" --version)"
if [[ "$version" != 'nsh 0.6.1 (2f51d86)' ]]; then
	echo 'nsh.sh: expected longbridge/nsh 0.6.1 (2f51d86); qualify another release before use' >&2
	exit 1
fi
if [[ "${1:-}" == mock ]]; then
	cd "$here"
	case "${2:-}:${3:-}" in
		run:*Fixture.tsx|test:*.test.ts|test:*.test.tsx) ;;
		*) echo 'Usage: nsh.sh mock {run <NameFixture.tsx>|test <day-relative test file>} [NSH options]' >&2; exit 2 ;;
	esac
	entry="${3#./}"
	case "/$entry/" in
		//*|/-*|*/../*|*/./*) echo 'Use a path relative to apps/day.' >&2; exit 2 ;;
	esac
	mkdir -p .nsh output
	mock="$(mktemp -d "$here/.nsh/mock.XXXXXX")"
	trap 'rm -rf "$mock"' EXIT
	# NSH requires assets inside the app directory. Copy the source and assets,
	# not the mixed app config, Rust targets or generated declarations.
	snapshot="$mock/apps/day"
	mkdir -p "$snapshot"
	shopt -s nullglob
	cp -R ./*.ts ./*.tsx app artifacts changes feedback insights missions screen-agent search \
		sessions settings sources today updates icons fonts ui theme.json "$snapshot/"
	# Preserve the relative import of the one shared runtime helper.
	shared=packages/kernel/src/diagnostics
	mkdir -p "$mock/$shared"
	cp "../../$shared/feedback-paths.ts" "$mock/$shared/"
	for fixture in fixtures/inspection fixtures/recovery; do
		mkdir -p "$snapshot/$fixture"
		cp "$fixture/nsh.json" "$fixture"/*.tsx "$snapshot/$fixture/"
	done
	if [[ ! -f "$snapshot/$entry" ]]; then
		echo "nsh.sh: no fixture or test at '$entry' in the Day mock snapshot" >&2
		exit 2
	fi
	ln -s "$here/output" "$snapshot/output"
	printf '%s\n' '{"name":"Pilot Day (mock)","id":"test.pilot.day.mock","theme":"theme.json","capabilities":{}}' > "$snapshot/nsh.json"
	cd "$snapshot"
	action="$2"
	shift 3
	CARGO=/usr/bin/false "$cli" "$action" "$entry" "$@"
	exit
fi
# shellcheck source=apps/day/scripts/build-env.sh
source "$here/scripts/build-env.sh"
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
