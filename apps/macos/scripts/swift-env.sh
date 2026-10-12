#!/usr/bin/env bash
# Source this before running swift build/test. It selects a macOS SDK where SwiftUI's @State works.
#
# From the macOS 27 SDK on, @State is a macro implemented by the SwiftUIMacros compiler plugin, which
# only ships with Xcode. With Command Line Tools alone, every @State fails to compile. Older SDKs still
# declare @State as a plain property wrapper, so we fall back to the newest installed one of those.
# An explicit SDKROOT is always respected.

# Prints 0 when the SDK declares @State as a macro.
pilot_sdk_state_is_macro() {
	local interface
	for interface in "$1"/System/Library/Frameworks/SwiftUICore.framework/Versions/A/Modules/SwiftUICore.swiftmodule/*.swiftinterface; do
		[ -f "$interface" ] || continue
		grep -q "public macro State(" "$interface"
		return
	done
	return 1
}

# True when the selected toolchain can expand SwiftUI macros (Xcode, not Command Line Tools).
pilot_has_swiftui_macros() {
	local developer plugins
	developer="$(xcode-select -p 2>/dev/null)" || return 1
	for plugins in "$developer/Platforms/MacOSX.platform/Developer/usr/lib/swift/host/plugins" \
		"$developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/host/plugins" "$developer/usr/lib/swift/host/plugins"; do
		[ -e "$plugins/libSwiftUIMacros.dylib" ] && return 0
	done
	return 1
}

pilot_select_sdk() {
	[ -z "${SDKROOT:-}" ] || return 0
	local current candidate
	current="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null)" || return 0
	pilot_sdk_state_is_macro "$current" || return 0
	pilot_has_swiftui_macros && return 0
	# Newest first; skip symlinks such as MacOSX.sdk so each SDK is checked once.
	while IFS= read -r candidate; do
		[ -L "$candidate" ] && continue
		if ! pilot_sdk_state_is_macro "$candidate"; then
			export SDKROOT="$candidate"
			return 0
		fi
	done < <(find "$(dirname "$current")" -maxdepth 1 -name 'MacOSX*.sdk' | sort -rV)
	echo "warning: $(basename "$current") needs Xcode's SwiftUIMacros plugin for @State, and no older macOS SDK" \
		"is installed. Install Xcode, or set SDKROOT to a macOS 26 SDK." >&2
}

pilot_select_sdk
