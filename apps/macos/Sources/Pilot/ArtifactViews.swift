import AppKit
import PilotCore
import SwiftUI

@MainActor
final class ArtifactViewState: ObservableObject {
    @Published var preview = true
    @Published var visible = false
    @Published var viewer = false
    @Published var exportMessage: String?
    @Published var exportError: String?
    @Published var exporting = false
    @Published var revision: ArtifactRevision?
    @Published var error: String?
    @Published var loading = false

    func load(_ reference: ArtifactReference, latest: Bool, client: PilotClient = AppModel.shared.client) async {
        loading = true
        error = nil
        do {
            let revision = try await client.artifact(reference, latest: latest)
            try Task.checkCancellation()
            self.revision = revision
            if !latest { ArtifactInlineCache.store(revision, for: reference, host: client.hostIdentity) }
        } catch {
            if !Task.isCancelled { self.error = error.localizedDescription }
        }
        if !Task.isCancelled { loading = false }
    }
}

/// Lazy transcript rows lose their state when scrolled away. Remember pinned revisions and
/// measured sizes so a recreated card keeps its height instead of reloading from a placeholder.
/// Sizes also persist across launches (once the app enables it), so a reopened chat starts each
/// card at its last measured size rather than the 4:3 placeholder.
@MainActor
enum ArtifactInlineCache {
    private struct Key: Hashable { let host: HostRef?; let reference: ArtifactReference }

    private static var revisions: [Key: ArtifactRevision] = [:]
    private static var revisionOrder: [Key] = []
    private static var revisionBytes: [Key: Int] = [:]
    private static var totalBytes = 0
    private static let revisionLimit = 32
    /// Image revisions can each hold 16 MiB or more. Bound memory by size as well as count.
    static let byteLimit = 64 * 1024 * 1024
    static let sizeLimit = 512
    private static var sizes = MeasuredSizeMemory(limit: sizeLimit)
    private static var persistence: UserDefaults?
    private static var saveTask: Task<Void, Never>?
    static let defaultsKey = "PilotArtifactInlineSizes"

    static func revision(for reference: ArtifactReference, host: HostRef? = nil) -> ArtifactRevision? { revisions[Key(host: host, reference: reference)] }

    static func store(_ revision: ArtifactRevision, for artifact: ArtifactReference, host: HostRef? = nil) {
        let reference = Key(host: host, reference: artifact)
        let bytes = revision.html.utf8.count + revision.source.utf8.count
        // A single oversized revision is not retained; the visible card already holds it.
        guard bytes <= byteLimit else { return }
        if revisions.updateValue(revision, forKey: reference) != nil {
            revisionOrder.removeAll { $0 == reference }
            totalBytes -= revisionBytes[reference] ?? 0
        }
        revisionOrder.append(reference)
        revisionBytes[reference] = bytes
        totalBytes += bytes
        while revisionOrder.count > revisionLimit || totalBytes > byteLimit {
            let evicted = revisionOrder.removeFirst()
            revisions[evicted] = nil
            totalBytes -= revisionBytes.removeValue(forKey: evicted) ?? 0
        }
    }

    static var retainedBytes: Int { totalBytes }

    static func contentSize(for reference: ArtifactReference, host: HostRef? = nil) -> CGSize? { sizes[sizeKey(reference, host)] }

    static func storeContentSize(_ size: CGSize?, for artifact: ArtifactReference, host: HostRef? = nil) {
        guard let size else { return }
        guard sizes.store(size, for: sizeKey(artifact, host)), persistence != nil else { return }
        scheduleSave()
    }

    /// Pinned revisions are immutable, so a revision's measured size stays valid. The title is not part of the key.
    static func sizeKey(_ reference: ArtifactReference, _ host: HostRef?) -> String {
        [host?.hostId ?? "", host?.daemonId ?? "", host?.lineageId ?? "", reference.sessionId, reference.id, String(reference.revision)]
            .map { $0.replacingOccurrences(of: "/", with: "%2F") }
            .joined(separator: "/")
    }

    /// Restore sizes saved by an earlier launch and keep saving new ones. Tests never call this.
    static func enablePersistence(_ defaults: UserDefaults = .standard) {
        persistence = defaults
        guard let data = defaults.data(forKey: defaultsKey),
              let saved = try? JSONDecoder().decode([MeasuredSizeMemory.Entry].self, from: data) else { return }
        // Measurements from this launch are newer than saved ones.
        sizes = MeasuredSizeMemory(limit: sizeLimit, entries: saved + sizes.entries)
    }

    static func disablePersistence() {
        flush()
        persistence = nil
    }

    /// Coalesce measurement bursts into one small write.
    private static func scheduleSave() {
        guard saveTask == nil else { return }
        saveTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(2))
            flush()
        }
    }

    static func flush() {
        saveTask?.cancel()
        saveTask = nil
        guard let persistence, let data = try? JSONEncoder().encode(sizes.entries) else { return }
        persistence.set(data, forKey: defaultsKey)
    }
}

/// The reference, not the session's current summary, pins this card to its saved revision.
/// Previews are shown by default and removed when a lazy transcript row leaves the screen.
struct ArtifactCard: View {
    @Environment(\.hostViewContext) private var hostContext
    @EndpointClient private var endpoint
    let reference: ArtifactReference
    @Environment(\.transcriptContentPrepared) private var contentPrepared
    @StateObject private var state: ArtifactViewState
    @StateObject private var render: ArtifactRenderState

    init(reference: ArtifactReference, host: HostRef? = nil) {
        self.reference = reference
        // Match the key the card stores under: without a host view context, the endpoint is the app's client.
        let host = host ?? AppModel.shared.client.hostIdentity
        _state = StateObject(wrappedValue: {
            let state = ArtifactViewState()
            state.revision = ArtifactInlineCache.revision(for: reference, host: host)
            return state
        }())
        _render = StateObject(wrappedValue: {
            let render = ArtifactRenderState()
            render.contentSize = ArtifactInlineCache.contentSize(for: reference, host: host)
            return render
        }())
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if state.preview {
                let image = state.revision?.kind == .image || state.revision?.kind == .swiftui
                // Reserve the measured size while offscreen, so the web view coming and going
                // never changes the row height under the user's scroll position.
                // Pages taller than the inline ceiling scroll inside the card.
                InlineArtifactLayout(contentSize: render.contentSize, image: image) {
                    if state.visible {
                        ArtifactContent(reference: reference, latest: false, inline: true, onOpen: { state.viewer = true },
                                        state: state, render: render)
                    } else {
                        Color.clear
                    }
                }
                // Artifacts are light documents. In dark, transparent inline ones sit on light paper to stay readable.
                .background(RoundedRectangle(cornerRadius: Theme.Radius.control).fill(state.visible ? Theme.artifactPaper : .clear))
                .clipped()
                // Share prose's leading edge. Small images keep their natural size, without a card.
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Button("Show \(reference.title)") { state.preview = true }
                    .buttonStyle(.plain).foregroundStyle(Theme.mutedForeground)
            }
        }
        .contextMenu {
            Button("Open artifact") { state.viewer = true }
            Button(state.preview ? "Hide preview" : "Show preview") { state.preview.toggle() }
        }
        .onAppear { state.visible = true }
        .onDisappear { state.visible = false }
        .onChange(of: render.contentSize) { _, size in
            ArtifactInlineCache.storeContentSize(size, for: reference, host: hostContext?.host ?? endpoint.hostIdentity)
            contentPrepared?()
        }
        .sheet(isPresented: $state.viewer) { ArtifactViewer(reference: reference, latest: false) }
    }
}

/// Start with a bounded viewport, then let measured content request more room.
struct InlineArtifactLayout: Layout {
    var contentSize: CGSize? = nil
    var image = false

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        ArtifactViewerLayout.inlineSize(availableWidth: proposal.width ?? Theme.column, contentSize: contentSize, image: image)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for subview in subviews {
            subview.place(at: bounds.origin, anchor: .topLeading,
                          proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
        }
    }
}

struct ArtifactViewer: View {
    let reference: ArtifactReference
    let latest: Bool
    @Environment(\.dismiss) private var dismiss
    @StateObject private var state = ArtifactViewState()
    @StateObject private var render = ArtifactRenderState()

    private var expandedSize: CGSize {
        ArtifactViewerLayout.size(available: NSApp.keyWindow?.screen?.visibleFrame.size
            ?? NSScreen.main?.visibleFrame.size ?? CGSize(width: 1440, height: 900), contentSize: render.contentSize)
    }

    var body: some View {
        VStack(spacing: 0) {
            ArtifactViewerHeader(reference: reference, latest: latest, state: state, render: render, close: { dismiss() })
            Divider()
            ArtifactContent(reference: reference, latest: latest, state: state, render: render)
        }
        .frame(width: expandedSize.width, height: expandedSize.height)
    }
}

struct ArtifactViewerHeader: View {
    @Environment(\.hostViewContext) private var hostContext
    @EndpointClient private var endpoint
    let reference: ArtifactReference
    let latest: Bool
    var host: HostRef? = nil
    @ObservedObject var state: ArtifactViewState
    @ObservedObject var render: ArtifactRenderState
    let close: () -> Void

    var revisionText: String {
        if let revision = state.revision { return "Revision \(revision.revision)" }
        return latest ? "Latest revision" : "Revision \(reference.revision)"
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Button(action: close) { PilotSymbol(PilotIcon.dismiss, context: .row).padding(6) }
                .buttonStyle(.plain)
                .keyboardShortcut(.cancelAction)
                .help("Close artifact")
                .accessibilityLabel("Close artifact")
            VStack(alignment: .leading, spacing: 4) {
                Text(state.revision?.title ?? reference.title).font(.headline).lineLimit(1)
                HStack(spacing: 6) {
                    Text(revisionText)
                    if let revision = state.revision {
                        Text("·")
                        Text(revision.kind.rawValue.uppercased())
                    }
                }
                .font(.caption).foregroundStyle(Theme.mutedForeground)
                if let error = state.exportError {
                    InlineProblem(error).lineLimit(2)
                } else if let message = state.exportMessage {
                    Text(message).font(.caption).foregroundStyle(Theme.mutedForeground)
                }
            }
            Spacer(minLength: 12)
            if let revision = state.revision {
                ArtifactShareMenu(revision: revision, host: host ?? hostContext?.host ?? endpoint.hostIdentity, state: state, render: render)
            }
        }
        .padding(14)
    }
}

private struct ArtifactContent: View {
    @Environment(\.hostViewContext) private var hostContext
    @Environment(\.transcriptComposer) private var composer
    @EndpointClient private var endpoint
    let reference: ArtifactReference
    let latest: Bool
    var inline = false
    var onOpen: (() -> Void)?
    @ObservedObject var state: ArtifactViewState
    @ObservedObject var render: ArtifactRenderState

    var body: some View {
        VStack(spacing: 0) {
            if state.loading {
                ProgressView("Loading artifact…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = state.error {
                EmptyStateView(icon: PilotIcon.warning, title: "Couldn't load this artifact", message: error) {
                    Button("Retry") { Task { await state.load(reference, latest: latest, client: endpoint) } }
                }
                .padding().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let revision = state.revision {
                // Pages are used in place; snapshots (images, SwiftUI) open the viewer on click.
                let interactive = !inline || revision.kind == .html || revision.kind == .react
                ArtifactPreview(revision: revision, inline: inline, state: render,
                                onEscape: inline ? { [weak composer] in composer?.composerFocus = UUID() } : nil)
                    .id("\(revision.id)-\(revision.revision)")
                    .allowsHitTesting(interactive)
                    .accessibilityHidden(!interactive)
                    .overlay {
                        if !interactive {
                            EmbeddedPreviewButton(title: "Open \(reference.title)",
                                help: "Click to expand", open: { onOpen?() })
                        }
                    }
                    .overlay(alignment: .topTrailing) {
                        if inline && interactive {
                            Button { onOpen?() } label: {
                                PilotSymbol(PilotIcon.expand, context: .row)
                                    .padding(6)
                                    .background(Circle().fill(Theme.card))
                                    .overlay(Circle().stroke(Theme.border))
                            }
                            .buttonStyle(.plain)
                            .padding(8)
                            .help("Open in the viewer")
                            .accessibilityLabel("Open \(reference.title) in the viewer")
                        }
                    }
            }
        }
        .task {
            render.loading = true
            render.error = nil
            // A pinned revision already loaded by this card (or its cache) is immutable.
            if !latest, state.revision != nil, state.error == nil { return }
            render.contentSize = inline ? ArtifactInlineCache.contentSize(for: reference, host: hostContext?.host ?? endpoint.hostIdentity) : nil
            await state.load(reference, latest: latest, client: endpoint)
        }
        .background(inline ? Color.clear : Theme.background)
    }
}

private struct ArtifactShareMenu: View {
    @Environment(\.hostViewContext) private var hostContext
    @EndpointClient private var endpoint
    let revision: ArtifactRevision
    var host: HostRef? = nil
    @ObservedObject var state: ArtifactViewState
    @ObservedObject var render: ArtifactRenderState

    var body: some View {
        Menu {
            Button("Copy file content") { performExport {
                ArtifactExport.copy(revision.source)
                return "Content copied"
            } }
            Button("Copy full path") { performExport {
                ArtifactExport.copy(try ArtifactExport.materialize(revision, host: host ?? hostContext?.host ?? endpoint.hostIdentity).path)
                return "Local file path copied"
            } }
            Button("Save file…") { performExport {
                try ArtifactExport.save(ArtifactExport.file(for: revision)) ? "File saved" : nil
            } }
            Button("Reveal in Finder") { performExport {
                NSWorkspace.shared.activateFileViewerSelecting([try ArtifactExport.materialize(revision, host: host ?? hostContext?.host ?? endpoint.hostIdentity)])
                return nil
            } }
            Divider()
            Button("Copy screenshot") { screenshot(revision, save: false) }
                .disabled(render.loading || render.error != nil)
                .help("Copy the full preview as a PNG image")
            Button("Export screenshot…") { screenshot(revision, save: true) }
                .disabled(render.loading || render.error != nil)
                .help("Save the full preview as a PNG image")
        } label: {
            Label("Share", icon: PilotIcon.share)
        }
        .fixedSize()
        .disabled(state.exporting)
        .help("Copy content or a local file path, save the source file, or capture the full preview")
    }

    private func performExport(_ operation: () throws -> String?) {
        state.exportError = nil
        state.exportMessage = nil
        do { state.exportMessage = try operation() }
        catch { state.exportError = error.localizedDescription }
    }

    private func screenshot(_ revision: ArtifactRevision, save: Bool) {
        state.exporting = true
        state.exportError = nil
        state.exportMessage = nil
        Task { @MainActor in
            defer { state.exporting = false }
            do {
                let data = try await render.snapshotPNG()
                if save {
                    let stem = try ArtifactExport.file(for: revision).name
                    let name = (stem as NSString).deletingPathExtension + "-screenshot.png"
                    if try ArtifactExport.save(.init(name: name, data: data, type: .png)) {
                        state.exportMessage = "Screenshot saved"
                    }
                } else {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setData(data, forType: .png)
                    state.exportMessage = "Screenshot copied"
                }
            } catch { state.exportError = error.localizedDescription }
        }
    }
}

private struct ArtifactPreview: View {
    @EndpointClient private var endpoint
    let revision: ArtifactRevision
    var inline = false
    @ObservedObject var state: ArtifactRenderState
    var onEscape: (() -> Void)? = nil

    var body: some View {
        ArtifactWebView(revision: revision, client: endpoint, inline: inline, state: state, onEscape: onEscape)
            .overlay {
                if let error = state.error {
                    Text(error).font(.callout).foregroundStyle(Theme.mutedForeground).padding()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(inline ? Color.clear : Theme.background)
                } else if state.loading { ProgressView("Starting sandbox…") }
            }
    }
}

/// The current chat's complete, live artifact index. Renderers only start when a row is opened.
struct SessionArtifactsPane: View {
    let sessionId: String
    @ObservedObject var client: PilotClient
    @StateObject private var state = SessionArtifactsState()
    @StateObject private var keyboardRows = KeyboardListState()

    private var artifacts: [ArtifactSummary] { client.artifacts[sessionId] ?? [] }

    var body: some View {
        VStack(spacing: 0) {
            InspectorPaneHeader("\(artifacts.count) artifact\(artifacts.count == 1 ? "" : "s")", trailing: {
                if state.loading { ProgressView().controlSize(.mini) }
                Button { Task { await load() } } label: {
                    PilotSymbol(PilotIcon.refresh, context: .toolbar)
                }
                .buttonStyle(QuietIconButtonStyle())
                .disabled(state.loading)
                .help("Refresh artifacts")
                .accessibilityLabel("Refresh artifacts")
            })
            if let error = state.error, !artifacts.isEmpty {
                InlineProblem(error, retrying: state.loading) { Task { await load() } }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if state.loading, artifacts.isEmpty {
                ProgressView("Loading artifacts…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if artifacts.isEmpty, let error = state.error {
                EmptyStateView(icon: PilotIcon.warning, title: "Artifacts unavailable", message: error) {
                    Button("Retry") { Task { await load() } }.disabled(state.loading)
                }
                .padding(.horizontal, 16)
                .frame(maxHeight: .infinity)
            } else if artifacts.isEmpty {
                EmptyStateView(icon: PilotIcon.artifact, title: "No artifacts yet",
                               message: "Pages, diagrams and images the agent publishes in this chat appear here.")
                    .padding(.horizontal, 16)
                    .frame(maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(artifacts) { artifact in
                            Button { state.selected = artifact.reference } label: {
                                HStack(spacing: 10) {
                                    PilotSymbol(artifact.kind == .image ? PilotIcon.image : PilotIcon.artifact)
                                        .foregroundStyle(Theme.mutedForeground)
                                    Text(artifact.title).font(.pilot(.body)).lineLimit(1)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                    Text("\(artifact.kind.rawValue.uppercased()) · r\(artifact.revision)")
                                        .font(.pilot(.caption, design: .monospaced)).foregroundStyle(Theme.mutedForeground)
                                }
                                .padding(12)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .help("Open \(artifact.title), latest revision")
                            .keyboardListItem(artifact.id) { state.selected = artifact.reference }
                            Rectangle().fill(Theme.border).frame(height: 1)
                        }
                    }
                    .keyboardList(region: .inspector, state: keyboardRows, suppliesRows: true)
                    .onChange(of: artifacts.map(\.id), initial: true) { _, _ in
                        keyboardRows.update(artifacts.map { artifact in
                            KeyboardListItem(id: artifact.id) { state.selected = artifact.reference }
                        })
                    }
                }
            }
        }
        .background(Theme.background)
        .task(id: sessionId) { await load() }
        .sheet(item: $state.selected) { reference in ArtifactViewer(reference: reference, latest: true) }
    }

    private func load() async {
        await state.load(sessionId: sessionId, client: client)
    }
}

@MainActor
final class SessionArtifactsState: ObservableObject {
    @Published var selected: ArtifactReference?
    @Published private(set) var loading = false
    @Published private(set) var error: String?

    func load(sessionId: String, client: PilotClient) async {
        guard !loading else { return }
        loading = true
        error = nil
        defer { loading = false }
        do { _ = try await client.sessionArtifacts(sessionId) }
        catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

@MainActor
private final class ProjectArtifactsState: ObservableObject {
    @Published var artifacts: [ArtifactSummary] = []
    @Published var selected: ArtifactReference?
    @Published var loading = false
    @Published var error: String?
}

struct ProjectArtifactsBrowser: View {
    @Environment(\.hostViewContext) private var hostContext
    let project: Project
    @ObservedObject var client: PilotClient
    @StateObject private var state = ProjectArtifactsState()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        SheetScaffold("Artifacts", subtitle: project.name, width: nil, fillsHeight: true, accessory: {
            Button("Refresh") { Task { await load() } }.disabled(state.loading)
        }) {
            if state.loading { ProgressView("Loading artifacts…").frame(maxWidth: .infinity) }
            if let error = state.error { InlineProblem(error, retrying: state.loading) { Task { await load() } } }
            if !state.loading, state.error == nil, state.artifacts.isEmpty {
                EmptyStateView(icon: PilotIcon.artifact, title: "No artifacts yet",
                               message: "Pages, diagrams and images agents publish in this project appear here.")
                    .frame(maxHeight: .infinity)
            } else {
                artifactList
            }
        }
        .frame(minWidth: 580, minHeight: 400)
        .task { await load() }
        .sheet(item: $state.selected) { ArtifactViewer(reference: $0, latest: true) }
    }

    private var artifactList: some View {
        List(state.artifacts) { artifact in
            HStack {
                Button { state.selected = artifact.reference } label: {
                    HStack {
                        Label(artifact.title, icon: PilotIcon.artifact)
                        Spacer()
                        Text("r\(artifact.revision)").font(.pilot(.caption, design: .monospaced))
                            .foregroundStyle(Theme.mutedForeground)
                    }
                }.buttonStyle(.plain)
                Button {
                    AppModel.shared.navigate(.session, id: artifact.sessionId, context: hostContext)
                    dismiss()
                } label: {
                    Label(client.session(artifact.sessionId)?.title ?? "Open chat", icon: PilotIcon.message)
                        .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                }
                .buttonStyle(.borderless)
                .help("Open originating chat: \(client.session(artifact.sessionId)?.title ?? artifact.sessionId)")
            }
        }
        .listStyle(.plain)
    }

    private func load() async {
        state.loading = true
        state.error = nil
        do {
            let list = try await client.projectArtifacts(project.id)
            try Task.checkCancellation()
            state.artifacts = list.sorted { $0.updatedAt > $1.updatedAt }
        } catch { if !Task.isCancelled { state.error = error.localizedDescription } }
        if !Task.isCancelled { state.loading = false }
    }
}
