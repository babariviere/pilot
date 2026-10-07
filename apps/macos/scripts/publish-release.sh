#!/usr/bin/env bash
# Publish a complete private GitHub release. Only run for trusted main-branch CI builds.
# Secrets are passed over stdin to sign_update, never on the command line or into the bundle.
set +x
set -euo pipefail
unset GH_DEBUG
here="$(cd "$(dirname "$0")/.." && pwd)"
app="${1:-$here/build/Pilot.app}"
: "${GH_TOKEN:?Set GH_TOKEN for release publishing}"
: "${PILOT_UPDATE_REPOSITORY:?Set PILOT_UPDATE_REPOSITORY}"
: "${SPARKLE_PRIVATE_KEY:?Set the base64 Sparkle private key secret}"
: "${GITHUB_SHA:?Set GITHUB_SHA to the release commit}"
# Workflow publication is serialized. A rerun of an old commit must not become latest.
main_sha="$(gh api "repos/$PILOT_UPDATE_REPOSITORY/commits/main" --jq '.sha')"
if [ "$GITHUB_SHA" != "$main_sha" ]; then
	echo "Skipping obsolete commit $GITHUB_SHA; main is now $main_sha."
	exit 0
fi
python3 - <<'PY'
import base64
import os
try:
    key = base64.b64decode(os.environ["SPARKLE_PRIVATE_KEY"].strip(), validate=True)
except ValueError:
    raise SystemExit("SPARKLE_PRIVATE_KEY must contain the base64 key exported by Sparkle generate_keys.")
if len(key) not in (32, 64, 96):
    raise SystemExit("SPARKLE_PRIVATE_KEY has an invalid size; use Sparkle generate_keys -x.")
PY
build_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app/Contents/Info.plist")"
tag="pilot-$build_version"
stage="$(mktemp -d "${TMPDIR:-/tmp}/pilot-release.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
archive="$stage/Pilot-arm64.zip"
"$here/scripts/fetch-sparkle.sh" "$stage/sparkle"
ditto -c -k --sequesterRsrc --keepParent "$app" "$archive"
signature="$(printf '%s\n' "$SPARKLE_PRIVATE_KEY" | "$stage/sparkle/bin/sign_update" --ed-key-file - -p "$archive")"
# Check against the PUBLIC KEY actually embedded in this app, not just the private key's own public half.
public_key="$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$app/Contents/Info.plist")"
node "$here/scripts/verify-update.mjs" "$archive" "$public_key" "$signature"
# Prove the ZIP preserves workspace links and works outside the checkout before uploading.
ditto -x -k "$archive" "$stage/extracted"
codesign --verify --deep --strict "$stage/extracted/Pilot.app"
"$here/scripts/check-runtime.sh" "$stage/extracted/Pilot.app/Contents/Resources/runtime"

gh release create "$tag" --repo "$PILOT_UPDATE_REPOSITORY" --target "$GITHUB_SHA" \
	--draft --title "Pilot $build_version (arm64)" \
	--notes "Apple Silicon (arm64) only. Built from commit $GITHUB_SHA. Ad-hoc signed, not notarized."
gh release upload "$tag" "$archive" --repo "$PILOT_UPDATE_REPOSITORY"
# Draft releases may not have a Git tag yet, so the REST by-tag endpoint returns 404.
# gh release view can find drafts; use its numeric REST ID, not its GraphQL node ID.
release_id="$(gh release view "$tag" --repo "$PILOT_UPDATE_REPOSITORY" --json databaseId --jq '.databaseId')"
asset_id="$(gh api "repos/$PILOT_UPDATE_REPOSITORY/releases/$release_id/assets" \
	--jq '.[] | select(.name == "Pilot-arm64.zip") | .id')"
python3 "$here/scripts/release_metadata.py" appcast "$app/Contents/Info.plist" \
	"$archive" "$asset_id" "$signature" "$stage/appcast.xml"
gh release upload "$tag" "$stage/appcast.xml" --repo "$PILOT_UPDATE_REPOSITORY"
# Drafts never appear in /releases/latest. Both assets must exist before we expose this release.
main_sha="$(gh api "repos/$PILOT_UPDATE_REPOSITORY/commits/main" --jq '.sha')"
if [ "$GITHUB_SHA" != "$main_sha" ]; then
	echo "Main advanced during packaging. Leaving $tag as a draft, not changing latest."
	exit 0
fi
if gh api "repos/$PILOT_UPDATE_REPOSITORY/releases/latest" > "$stage/latest.json" 2> "$stage/latest-error"; then
	latest_tag="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["tag_name"])' "$stage/latest.json")"
else
	# Only a 404 means there is no latest release yet. Authentication/network failures must fail closed.
	if grep -q 'HTTP 404' "$stage/latest-error"; then
		latest_tag=""
	else
		echo "Unable to query latest release; refusing to publish." >&2
		exit 1
	fi
fi
if ! python3 "$here/scripts/release_metadata.py" is-newer "$build_version" "$latest_tag"; then
	echo "Leaving $tag as a draft; $latest_tag already has an equal or newer build version."
	exit 0
fi
gh release edit "$tag" --repo "$PILOT_UPDATE_REPOSITORY" --draft=false --latest
