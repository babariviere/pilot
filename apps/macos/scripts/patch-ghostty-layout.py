#!/usr/bin/env python3
"""Let SwiftUI allocate the terminal viewport without AppKit fitting-size feedback."""

from pathlib import Path
import sys


LAYOUT = '''// Pilot: the terminal consumes its viewport; it has no content-driven ideal size.
#if !canImport(UIKit) && canImport(AppKit)
import AppKit
import SwiftUI

extension TerminalViewRepresentable {
    // The default NSViewRepresentable sizing bridge infers constraints from the native
    // view. A fitting-size invalidation during placement can then start another window
    // constraint pass. Do not consult or mutate the native view while measuring it.
    func sizeThatFits(_ proposal: ProposedViewSize, nsView _: TerminalView, context _: Context) -> CGSize? {
        proposal.replacingUnspecifiedDimensions(by: .zero)
    }
}
#endif
'''


def patch(package: Path) -> None:
    source = package / "Sources/GhosttyTerminal/View/TerminalViewRepresentable+PilotLayout.swift"
    if not source.exists() or source.read_text() != LAYOUT:
        source.write_text(LAYOUT)


if __name__ == "__main__":
    patch(Path(sys.argv[1]))
