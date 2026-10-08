import AppKit
import PilotCore
import SwiftUI

/// Scopes selection to one project and ignores late responses after switching projects or refreshing.
@MainActor
final class BranchSelectorState: ObservableObject {
    var onSelectionChanged: (() -> Void)?
    @Published private(set) var scope: String? { didSet { onSelectionChanged?() } }
    @Published private(set) var list = RemoteBranchList()
    @Published private(set) var selected: String? { didSet { onSelectionChanged?() } }
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    private var request = UUID()

    /// Validate this saved selection against origin when the composer next loads its branch list.
    func restoreSelection(scope: String?, branch: String?) {
        self.scope = scope
        selected = branch
    }

    func selection(for scope: String?) -> String? {
        guard scope != nil, self.scope == scope else { return nil }
        return selected
    }

    func select(_ branch: String?, for scope: String) {
        guard self.scope == scope else { return }
        if let branch, !list.branches.contains(branch) { return }
        selected = branch
    }

    func load(scope: String?, fetch: () async throws -> RemoteBranchList) async {
        let request = UUID()
        self.request = request
        if self.scope != scope {
            self.scope = scope
            list = RemoteBranchList()
            selected = nil
        }
        error = nil
        loading = scope != nil
        guard scope != nil else { return }
        defer { if self.request == request { loading = false } }
        do {
            let result = try await fetch()
            guard self.request == request, !Task.isCancelled else { return }
            list = result
            if let selected, !result.branches.contains(selected) {
                self.selected = nil
                error = "The selected branch is no longer on origin. Choose another base branch."
            }
        } catch {
            guard self.request == request, !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }
}

struct BranchMenu: View {
    @ObservedObject var state: BranchSelectorState
    let scope: String
    let refresh: () -> Void

    private var list: RemoteBranchList { state.scope == scope ? state.list : RemoteBranchList() }
    private var selected: String? { state.selection(for: scope) }

    var body: some View {
        Menu {
            Text("Base branch · origin only")
            Button {
                state.select(nil, for: scope)
            } label: {
                let title = list.defaultBranch.map { "Default (\($0))" } ?? "Default branch"
                if selected == nil { Label(title, systemImage: "checkmark") } else { Text(title) }
            }
            Divider()
            ForEach(list.branches, id: \.self) { branch in
                Button {
                    state.select(branch, for: scope)
                } label: {
                    if selected == branch { Label(branch, systemImage: "checkmark") } else { Text(branch) }
                }
            }
            if state.loading { Text("Loading branches…") }
            else if list.branches.isEmpty { Text("No origin branches available") }
            if let error = state.error { Text(error) }
            Divider()
            Button("Refresh branches", action: refresh).disabled(state.loading)
        } label: {
            ChipLabel(title: selected ?? list.defaultBranch ?? "Default branch", templateImage: GitBranchGlyph.image)
                .frame(maxWidth: 170)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize(horizontal: false, vertical: true)
        .help(state.error ?? "Base branch: \(selected.map { "origin/\($0)" } ?? "remote default"). Starts a new private workspace.")
        .accessibilityLabel("Base branch")
        .accessibilityValue(selected ?? list.defaultBranch ?? "Remote default")
    }
}

/// A familiar Git branch with commit nodes, rendered as a template for native menu labels.
enum GitBranchGlyph {
    static let image: NSImage = {
        let image = NSImage(size: NSSize(width: 14, height: 14), flipped: true) { rect in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            context.scaleBy(x: rect.width / 14, y: rect.height / 14)
            context.setStrokeColor(NSColor.black.cgColor)
            context.setLineWidth(1.3)
            context.setLineCap(.round)
            context.move(to: CGPoint(x: 3.5, y: 4.2))
            context.addLine(to: CGPoint(x: 3.5, y: 9.7))
            context.move(to: CGPoint(x: 3.5, y: 9))
            context.addCurve(to: CGPoint(x: 10.5, y: 4.2),
                             control1: CGPoint(x: 8, y: 9), control2: CGPoint(x: 10.5, y: 8))
            context.strokePath()
            for center in [CGPoint(x: 3.5, y: 2.5), CGPoint(x: 10.5, y: 2.5), CGPoint(x: 3.5, y: 11.4)] {
                context.strokeEllipse(in: CGRect(x: center.x - 1.7, y: center.y - 1.7, width: 3.4, height: 3.4))
            }
            return true
        }
        image.isTemplate = true
        return image
    }()
}
