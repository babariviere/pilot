#!/usr/bin/env bash
# Upload the signed macOS update ZIP and appcast to a stable draft. Only run for trusted main-branch CI builds.
# finalize-release.sh publishes the draft after every platform has uploaded its assets.
# Secrets are passed over stdin to sign_update, never on the command line or into the bundle.
set +x
set -euo pipefail
unset GH_DEBUG
here="$(cd "$(dirname "$0")/.." && pwd)"
app="${1:-$here/build/Pilot.app}"
: "${GH_TOKEN:?Set GH_TOKEN for release publishing}"
: "${PILOT_UPDATE_REPOSITORY:?Set PILOT_UPDATE_REPOSITORY}"
: "${SPARKLE_PRIVATE_KEY:?Set the base64 Sparkle private key secret}"
: "${RELEASE_TAG:?Set RELEASE_TAG to an existing stable draft tag}"
[ "${RELEASE_KIND:-stable}" = stable ] || { echo "Only stable releases can be published" >&2; exit 1; }
stage="$(mktemp -d "${TMPDIR:-/tmp}/pilot-release.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
app_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"
build_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app/Contents/Info.plist")"
tag="$RELEASE_TAG"
# A retry may run after main advances, but it must still build exactly the tagged source.
source_sha="$(git -C "$here/../.." rev-parse HEAD)"
[ "$tag" = "v$app_version" ] || { echo "Release tag does not match the bundled app version" >&2; exit 1; }
python3 - "$app_version" "$here/scripts" <<'PY'
import sys
sys.path.insert(0, sys.argv[2])
from release_metadata import stable_version
stable_version(sys.argv[1])
PY
tag_sha="$(gh api "repos/$PILOT_UPDATE_REPOSITORY/commits/$tag" --jq '.sha')"
[ "$source_sha" = "$tag_sha" ] || { echo "Checkout does not match the release tag" >&2; exit 1; }
# Never overwrite a published release or create prereleases.
if ! gh release view "$tag" --repo "$PILOT_UPDATE_REPOSITORY" --json isDraft,isPrerelease,assets \
	> "$stage/release.json"; then
	echo "Unable to find the release draft; refusing to publish." >&2
	exit 1
fi
python3 "$here/scripts/release_metadata.py" release-state "$stage/release.json"
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
archive="$stage/Pilot-arm64.zip"
"$here/scripts/fetch-sparkle.sh" "$stage/sparkle"
if [ -n "${2:-}" ]; then
	# CI promotes the exact ZIP already validated by the release workflow's macos-app job. Local callers may still package an app.
	cp "$2" "$archive"
else
	ditto -c -k --sequesterRsrc --keepParent "$app" "$archive"
fi
signature="$(printf '%s\n' "$SPARKLE_PRIVATE_KEY" | "$stage/sparkle/bin/sign_update" --ed-key-file - -p "$archive")"
# Check against the PUBLIC KEY actually embedded in this app, not just the private key's own public half.
public_key="$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$app/Contents/Info.plist")"
node "$here/scripts/verify-update.mjs" "$archive" "$public_key" "$signature"
# Prove the ZIP preserves workspace links and works outside the checkout before uploading.
ditto -x -k "$archive" "$stage/extracted"
codesign --verify --deep --strict "$stage/extracted/Pilot.app"
"$here/scripts/check-runtime.sh" "$stage/extracted/Pilot.app/Contents/Resources/runtime"

gh release upload "$tag" "$archive" --repo "$PILOT_UPDATE_REPOSITORY" --clobber
# Draft releases may not have a Git tag yet, so the REST by-tag endpoint returns 404.
# gh release view can find drafts; use its numeric REST ID, not its GraphQL node ID.
release_id="$(gh release view "$tag" --repo "$PILOT_UPDATE_REPOSITORY" --json databaseId --jq '.databaseId')"
asset_id="$(gh api "repos/$PILOT_UPDATE_REPOSITORY/releases/$release_id/assets" \
	--jq '.[] | select(.name == "Pilot-arm64.zip") | .id')"
python3 "$here/scripts/release_metadata.py" appcast "$app/Contents/Info.plist" \
	"$archive" "$asset_id" "$signature" "$stage/appcast.xml"
gh release upload "$tag" "$stage/appcast.xml" --repo "$PILOT_UPDATE_REPOSITORY" --clobber
# finalize-release.sh publishes the draft once the Linux runtime assets are attached too.
