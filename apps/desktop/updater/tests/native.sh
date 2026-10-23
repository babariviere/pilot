#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PILOT_NEXT_SPARKLE_FRAMEWORK_DIR:?Explicit pinned Sparkle.framework parent required}"
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PILOT_NEXT_SPARKLE_FRAMEWORK_DIR/Sparkle.framework/Resources/Info.plist")"
[[ "$version" == 2.8.1 ]] || { echo 'Only reviewed Sparkle 2.8.1 is supported' >&2; exit 1; }
mkdir -p .native-test
/usr/bin/clang -fobjc-arc -fblocks -Wall -Wextra -Werror -Wno-unused-parameter \
  -Wno-deprecated-declarations -mmacosx-version-min=15.0 \
  -F "$PILOT_NEXT_SPARKLE_FRAMEWORK_DIR" -framework Foundation -framework AppKit -framework Sparkle \
  tests/native.m -o .native-test/updater-native
DYLD_FRAMEWORK_PATH="$PILOT_NEXT_SPARKLE_FRAMEWORK_DIR" .native-test/updater-native
