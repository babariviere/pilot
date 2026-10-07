#!/usr/bin/env python3
"""Keep Ghostty's resources in the signed app's standard Resources directory."""

from pathlib import Path
import sys


ACCESSOR = '''import Foundation

extension Bundle {
    // swift build's generated Bundle.module checks the app root, not
    // Contents/Resources. Never fall back to a checkout-local bundle in an app.
    static nonisolated let pilotModule: Bundle = {
        guard Bundle.main.bundleURL.pathExtension == "app" else {
            return Bundle.module
        }
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("GhosttyKit_GhosttyTerminal.bundle"),
              let bundle = Bundle(url: url) else {
            fatalError("Ghostty resource bundle missing from Pilot.app/Contents/Resources")
        }
        return bundle
    }()
}
'''


def patch(package: Path) -> None:
    sources = package / "Sources/GhosttyTerminal"
    accessor = sources / "Configuration/PilotResourceBundle.swift"
    for source in sources.rglob("*.swift"):
        if source == accessor:
            continue
        original = source.read_text()
        updated = original.replace("Bundle.module", "Bundle.pilotModule").replace(
            "bundle: .module", "bundle: .pilotModule"
        )
        if updated != original:
            source.write_text(updated)
    if not accessor.exists() or accessor.read_text() != ACCESSOR:
        accessor.write_text(ACCESSOR)


if __name__ == "__main__":
    patch(Path(sys.argv[1]))
