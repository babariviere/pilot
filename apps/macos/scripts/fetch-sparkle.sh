#!/usr/bin/env bash
# Pinned Sparkle tools, authenticated by the release asset's published SHA-256 digest.
set -euo pipefail
destination="${1:?Usage: fetch-sparkle.sh destination}"
mkdir -p "$destination"
curl --fail --location --retry 3 \
	https://github.com/sparkle-project/Sparkle/releases/download/2.8.1/Sparkle-2.8.1.tar.xz \
	-o "$destination/sparkle.tar.xz"
echo '5cddb7695674ef7704268f38eccaee80e3accbf19e61c1689efff5b6116d85be  sparkle.tar.xz' > "$destination/sparkle.sha256"
(cd "$destination"; shasum -a 256 -c sparkle.sha256; tar -xf sparkle.tar.xz)
rm "$destination/sparkle.tar.xz" "$destination/sparkle.sha256"
