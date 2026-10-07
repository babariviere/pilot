#!/usr/bin/env bash
# One-time, interactive configuration. Never run from CI; never print the private key.
set +x
set -euo pipefail
unset GH_DEBUG
umask 077
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="${1:-${PILOT_UPDATE_REPOSITORY:-}}"
command -v gh >/dev/null || { echo "Install GitHub CLI and run gh auth login first." >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || { echo "Sparkle key setup requires macOS Keychain." >&2; exit 1; }
if [ -z "$repo" ]; then
	repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
fi
python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); from release_metadata import repository; repository(sys.argv[2])' "$here/scripts" "$repo"
stage="$(mktemp -d "${TMPDIR:-/tmp}/pilot-update-setup.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
"$here/scripts/fetch-sparkle.sh" "$stage/tools"
echo "This will generate or reuse a repository-specific Sparkle key in your macOS Keychain."
echo "It will export the private key temporarily and set SPARKLE_PRIVATE_KEY (secret) and"
echo "SPARKLE_PUBLIC_KEY (variable) in $repo. Do not replace an existing release key."
printf 'Continue? [y/N] '
read -r answer
case "$answer" in y|Y|yes|YES) ;; *) echo "Cancelled."; exit 0 ;; esac
account="pilot:$repo"
"$stage/tools/bin/generate_keys" --account "$account"
public_key="$("$stage/tools/bin/generate_keys" --account "$account" -p)"
existing_key="$(gh variable list --repo "$repo" --json name,value \
	--jq '.[] | select(.name == "SPARKLE_PUBLIC_KEY") | .value')"
if [ -n "$existing_key" ] && [ "$existing_key" != "$public_key" ]; then
	echo "Refusing to replace $repo's existing Sparkle signing key." >&2
	echo "Recover its matching private key from the original Mac or a secure backup, then" >&2
	echo "import it with generate_keys --account '$account' -f PRIVATE_KEY_FILE." >&2
	echo "Do not rotate the public key blindly; installed apps trust the original key." >&2
	exit 1
fi
"$stage/tools/bin/generate_keys" --account "$account" -x "$stage/private-key"
gh secret set SPARKLE_PRIVATE_KEY --repo "$repo" < "$stage/private-key"
rm "$stage/private-key"
gh variable set SPARKLE_PUBLIC_KEY --repo "$repo" --body "$public_key"
echo "Configured $repo. Back up the signing key securely from Keychain, not in the repository."
