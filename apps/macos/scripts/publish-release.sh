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
: "${RELEASE_TAG:?Set RELEASE_TAG to a stable draft tag or dev-<commit SHA>}"
kind="${RELEASE_KIND:-stable}"
stage="$(mktemp -d "${TMPDIR:-/tmp}/pilot-release.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
app_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"
build_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app/Contents/Info.plist")"
tag="$RELEASE_TAG"
# A retry may run after main advances, but it must still build exactly the tagged source.
source_sha="$(git -C "$here/../.." rev-parse HEAD)"
case "$kind" in
	stable)
		[ "$tag" = "v$app_version" ] || { echo "Release tag does not match the bundled app version" >&2; exit 1; }
		target="$tag"
		;;
	dev)
		[ "$tag" = "dev-${source_sha:0:12}" ] && [[ "$app_version" = *"-dev.${source_sha:0:12}" ]] || {
			echo "Dev tag and app version must match the checkout SHA" >&2; exit 1;
		}
		target="$source_sha"
		;;
	*) echo "RELEASE_KIND must be stable or dev" >&2; exit 1 ;;
esac
tag_sha="$(gh api "repos/$PILOT_UPDATE_REPOSITORY/commits/$target" --jq '.sha')"
[ "$source_sha" = "$tag_sha" ] || { echo "Checkout does not match the release tag" >&2; exit 1; }
# Never overwrite a published release. A completed dev SHA is idempotent on reruns.
if gh release view "$tag" --repo "$PILOT_UPDATE_REPOSITORY" --json isDraft,isPrerelease,assets \
	> "$stage/release.json" 2> "$stage/release-error"; then
	state="$(python3 "$here/scripts/release_metadata.py" release-state "$stage/release.json" "$kind")"
	if [ "$state" = complete ]; then
		echo "Dev release $tag is already complete."
		exit 0
	fi
elif [ "$kind" = dev ] && grep -q '^release not found$' "$stage/release-error"; then
	gh release create "$tag" --repo "$PILOT_UPDATE_REPOSITORY" --target "$source_sha" \
		--draft --prerelease --title "Pilot $tag (arm64)" \
		--notes "Development build from commit $source_sha. Apple Silicon only. Ad-hoc signed, not notarized."
else
	echo "Unable to find the release draft; refusing to publish." >&2
	cat "$stage/release-error" >&2
	exit 1
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
archive="$stage/Pilot-arm64.zip"
dmg="$stage/Pilot-arm64.dmg"
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
"$here/scripts/create-dmg.sh" "$app" "$dmg"

gh release upload "$tag" "$archive" --repo "$PILOT_UPDATE_REPOSITORY" --clobber
gh release upload "$tag" "$dmg" --repo "$PILOT_UPDATE_REPOSITORY" --clobber
# Draft releases may not have a Git tag yet, so the REST by-tag endpoint returns 404.
# gh release view can find drafts; use its numeric REST ID, not its GraphQL node ID.
release_id="$(gh release view "$tag" --repo "$PILOT_UPDATE_REPOSITORY" --json databaseId --jq '.databaseId')"
asset_id="$(gh api "repos/$PILOT_UPDATE_REPOSITORY/releases/$release_id/assets" \
	--jq '.[] | select(.name == "Pilot-arm64.zip") | .id')"
python3 "$here/scripts/release_metadata.py" appcast "$app/Contents/Info.plist" \
	"$archive" "$asset_id" "$signature" "$stage/appcast.xml"
gh release upload "$tag" "$stage/appcast.xml" --repo "$PILOT_UPDATE_REPOSITORY" --clobber
# Drafts never appear in /releases/latest. All three assets must exist before publication.
if [ "$kind" = dev ]; then
	gh release edit "$tag" --repo "$PILOT_UPDATE_REPOSITORY" --draft=false --prerelease --latest=false
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
if ! python3 "$here/scripts/release_metadata.py" is-newer "$app_version" "$latest_tag"; then
	echo "Leaving $tag as a draft; $latest_tag already has an equal or newer app version."
	exit 0
fi
if [ -n "$latest_tag" ]; then
	# A delayed run must also stay newer in Sparkle's numeric build ordering. If an
	# earlier stable release was retried in a newer run, dispatch this draft again.
	latest_appcast_id="$(python3 - "$stage/latest.json" <<'PY'
import json, sys
assets = [a['id'] for a in json.load(open(sys.argv[1]))['assets'] if a['name'] == 'appcast.xml']
if len(assets) != 1:
    raise SystemExit('Latest release must have exactly one appcast.xml asset.')
print(assets[0])
PY
)"
	gh api "repos/$PILOT_UPDATE_REPOSITORY/releases/assets/$latest_appcast_id" \
		-H 'Accept: application/octet-stream' > "$stage/latest-appcast.xml"
	if ! python3 "$here/scripts/release_metadata.py" is-newer-build "$build_version" "$stage/latest-appcast.xml"; then
		echo "Leaving $tag as a draft; retry it in a new workflow run for a newer Sparkle build version."
		exit 0
	fi
fi
gh release edit "$tag" --repo "$PILOT_UPDATE_REPOSITORY" --draft=false --latest
