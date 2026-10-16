// Static artifact source only, not compiled into the app or a test target.
// Parent may publish this entire file as kind: swiftui. SwiftUI/AppKit/Foundation
// are supplied by the artifact renderer. This is mock data, not the real views.
// Palette, typography and hairline hierarchy mirror Theme.swift.
private enum SharingMockTheme {
    static let background = Color(nsColor: .init(name: nil) { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            ? NSColor(white: 0.149, alpha: 1) : NSColor.white
    })
    static let foreground = Color(nsColor: .init(name: nil) { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            ? NSColor(white: 0.831, alpha: 1) : NSColor(white: 0.149, alpha: 1)
    })
    static let muted = Color(nsColor: .init(name: nil) { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            ? NSColor(white: 0.604, alpha: 1) : NSColor(white: 0.420, alpha: 1)
    })
    static let border = foreground.opacity(0.12)
}

struct ArtifactView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Project memory").font(.system(size: 15, weight: .semibold))
                Text("Notes are saved on Local · Missions are saved on Local · Work runs on Personal devbox")
                    .font(.system(size: 11)).foregroundStyle(SharingMockTheme.muted)
            }
            VStack(alignment: .leading, spacing: 10) {
                heading("Saved here")
                note("Use the existing repository checkout on each devbox. Workspace files are not shared.",
                     detail: "Note 28 · Open chat on Local")
                note("Keep the public API changes backward compatible.", detail: "Note 27 · Open chat on Personal devbox")
            }
            VStack(alignment: .leading, spacing: 10) {
                heading("Pending sharing")
                note("The Linux fixture needs an additional reconnect test.", detail: "Saved on Personal devbox, waiting to share")
            }
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    heading("Conflicting edits")
                    Spacer()
                    Text("Review").font(.system(size: 12))
                }
                note("Two edits changed the task description.", detail: "Kept separately from saved content. Review on Local.")
            }
            VStack(alignment: .leading, spacing: 10) {
                heading("Run task on Personal devbox")
                Text("Disconnected · Stop requested")
                    .font(.system(size: 13)).foregroundStyle(SharingMockTheme.muted)
                Text("The task stays on this devbox until it confirms release. It may still be running.")
                    .font(.system(size: 12)).foregroundStyle(SharingMockTheme.muted)
                HStack {
                    Text("Check status")
                    Spacer()
                    Text("Start on another devbox").opacity(0.45)
                }.font(.system(size: 12))
                Rectangle().fill(SharingMockTheme.border).frame(height: 1)
            }
            VStack(alignment: .leading, spacing: 8) {
                heading("Share project information")
                Text("Notes: Pilot on Local · Missions: 2 selected · Work runs on Pilot on Personal devbox")
                    .font(.system(size: 12)).foregroundStyle(SharingMockTheme.muted)
                Text("1 of 2 devboxes confirmed. Reconnect, then finish linking with the same scope.")
                    .font(.system(size: 12)).foregroundStyle(SharingMockTheme.muted)
                Text("Project files, sign-ins, settings and access approvals are not copied.")
                    .font(.system(size: 11)).foregroundStyle(SharingMockTheme.muted)
                HStack { Spacer(); Text("Finish linking").font(.system(size: 12, weight: .medium)) }
            }
            Text("Static mock of embedded sections, not a screenshot of the running app.")
                .font(.system(size: 11)).foregroundStyle(SharingMockTheme.muted)
        }
        .padding(28).frame(width: 680, alignment: .leading)
        .foregroundStyle(SharingMockTheme.foreground).background(SharingMockTheme.background)
    }
    private func heading(_ title: String) -> some View {
        Text(title).font(.system(size: 13, weight: .semibold))
    }
    private func note(_ title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.system(size: 13)).fixedSize(horizontal: false, vertical: true)
            Text(detail).font(.system(size: 11)).foregroundStyle(SharingMockTheme.muted)
            Rectangle().fill(SharingMockTheme.border).frame(height: 1).padding(.top, 5)
        }
    }
}
