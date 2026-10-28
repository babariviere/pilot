#!/usr/bin/env bash
# Publish a stable draft once the Rust GUI jobs have uploaded their signed assets.
# Only run for trusted main-branch CI builds. Needs gh and python3, not macOS tools.
set +x
set -euo pipefail
unset GH_DEBUG
here="$(cd "$(dirname "$0")/.." && pwd)"
: "${GH_TOKEN:?Set GH_TOKEN for release publishing}"
: "${PILOT_UPDATE_REPOSITORY:?Set PILOT_UPDATE_REPOSITORY}"
: "${RELEASE_TAG:?Set RELEASE_TAG to an existing stable draft tag}"
stage="$(mktemp -d "${TMPDIR:-/tmp}/pilot-finalize.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
tag="$RELEASE_TAG"
app_version="${tag#v}"
[ "$tag" = "v$app_version" ] || { echo "Release tag must start with v" >&2; exit 1; }
# Never overwrite a published release or publish an incomplete draft.
if ! gh release view "$tag" --repo "$PILOT_UPDATE_REPOSITORY" --json isDraft,isPrerelease,assets \
	> "$stage/release.json"; then
	echo "Unable to find the release draft; refusing to publish." >&2
	exit 1
fi
python3 "$here/scripts/release_metadata.py" complete-draft "$stage/release.json"
# Draft releases may not have a Git tag yet, so use the numeric REST ID from gh release view.
release_id="$(gh release view "$tag" --repo "$PILOT_UPDATE_REPOSITORY" --json databaseId --jq '.databaseId')"
# Verify both signed GUI envelopes against GitHub's current immutable asset IDs/digests.
# This also refuses a retry that replaced an archive without replacing its envelope.
gh api "repos/$PILOT_UPDATE_REPOSITORY/releases/$release_id" > "$stage/release-api.json"
for platform in macos-arm64 linux-x64; do
	name="desktop-$platform-update.json"
	asset_id="$(gh api "repos/$PILOT_UPDATE_REPOSITORY/releases/$release_id/assets" \
		--jq ".[] | select(.name == \"$name\" and .state == \"uploaded\") | .id")"
	gh api "repos/$PILOT_UPDATE_REPOSITORY/releases/assets/$asset_id" \
		-H 'Accept: application/octet-stream' > "$stage/$name"
done
node "$here/../desktop/scripts/gui-release-manifest.mjs" verify-release "$stage"
# Drafts never appear in /releases/latest.
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
gh release edit "$tag" --repo "$PILOT_UPDATE_REPOSITORY" --draft=false --latest
