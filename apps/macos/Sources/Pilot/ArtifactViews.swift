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

    func load(_ reference: ArtifactReference, latest: Bool) async {
        loading = true
        error = nil
        do {
            let revision = try await AppModel.shared.client.artifact(reference, latest: latest)
            try Task.checkCancellation()
            self.revision = revision
        } catch {
            if !Task.isCancelled { self.error = error.localizedDescription }
        }
        if !Task.isCancelled { loading = false }
    }
}

/// The reference, not the session's current summary, pins this card to its saved revision.
/// Previews are shown by default and removed when a lazy transcript row leaves the screen.
struct ArtifactCard: View {
    let reference: ArtifactReference
    @Environment(\.transcriptContentPrepared) private var contentPrepared
    @StateObject private var state = ArtifactViewState()
    @StateObject private var render = ArtifactRenderState()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if state.preview, state.visible {
                InlineArtifactLayout(contentSize: render.contentSize,
                                     image: state.revision?.kind == .image || state.revision?.kind == .swiftui) {
                    ArtifactContent(reference: reference, latest: false, inline: true, onOpen: { state.viewer = true },
                                    state: state, render: render)
                }
                .clipShape(RoundedRectangle(cornerRadius: 6))
            } else {
                Button("Show \(reference.title)") { state.preview = true }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
            }
        }
        .contextMenu {
            Button("Open artifact") { state.viewer = true }
            Button(state.preview ? "Hide preview" : "Show preview") { state.preview.toggle() }
        }
        .onAppear { state.visible = true }
        .onDisappear { state.visible = false }
        .onChange(of: render.contentSize) { _, _ in contentPrepared?() }
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
    let reference: ArtifactReference
    let latest: Bool
    @ObservedObject var state: ArtifactViewState
    @ObservedObject var render: ArtifactRenderState
    let close: () -> Void

    var revisionText: String {
        if let revision = state.revision { return "Revision \(revision.revision)" }
        return latest ? "Latest revision" : "Revision \(reference.revision)"
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Button(action: close) { Image(systemName: "xmark").font(.system(size: 12, weight: .medium)).padding(6) }
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
                .font(.caption).foregroundStyle(.secondary)
                if let error = state.exportError {
                    Text(error).font(.caption).foregroundStyle(.red).lineLimit(2).textSelection(.enabled)
                } else if let message = state.exportMessage {
                    Text(message).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 12)
            if let revision = state.revision {
                ArtifactShareMenu(revision: revision, state: state, render: render)
            }
        }
        .padding(14)
    }
}

private struct ArtifactContent: View {
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
                VStack(spacing: 8) {
                    Text(error).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                    Button("Retry") { Task { await state.load(reference, latest: latest) } }
                }
                .padding().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let revision = state.revision {
                ArtifactPreview(revision: revision, state: render).id("\(revision.id)-\(revision.revision)")
                    .allowsHitTesting(!inline)
                    .accessibilityHidden(inline)
                    .overlay {
                        if inline {
                            EmbeddedPreviewButton(title: "Open \(reference.title)",
                                help: revision.kind == .react ? "Click to interact" : "Click to expand",
                                open: { onOpen?() })
                        }
                    }
            }
        }
        .task {
            render.loading = true
            render.error = nil
            render.contentSize = nil
            await state.load(reference, latest: latest)
        }
        .background(Theme.background)
    }
}

private struct ArtifactShareMenu: View {
    let revision: ArtifactRevision
    @ObservedObject var state: ArtifactViewState
    @ObservedObject var render: ArtifactRenderState

    var body: some View {
        Menu {
            Button("Copy file content") { performExport {
                ArtifactExport.copy(revision.source)
                return "Content copied"
            } }
            Button("Copy full path") { performExport {
                ArtifactExport.copy(try ArtifactExport.materialize(revision).path)
                return "Local file path copied"
            } }
            Button("Save file…") { performExport {
                try ArtifactExport.save(ArtifactExport.file(for: revision)) ? "File saved" : nil
            } }
            Button("Reveal in Finder") { performExport {
                NSWorkspace.shared.activateFileViewerSelecting([try ArtifactExport.materialize(revision)])
                return nil
            } }
            Divider()
            Button("Copy screenshot") { screenshot(revision, save: false) }
                .disabled(render.loading || render.error != nil)
                .help("Copy the visible preview as a PNG image")
            Button("Export screenshot…") { screenshot(revision, save: true) }
                .disabled(render.loading || render.error != nil)
                .help("Save the visible preview as a PNG image")
        } label: {
            Label("Share", systemImage: "square.and.arrow.up")
        }
        .fixedSize()
        .disabled(state.exporting)
        .help("Copy content or a local file path, save the source file, or capture the visible preview")
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
    let revision: ArtifactRevision
    @ObservedObject var state: ArtifactRenderState

    var body: some View {
        ArtifactWebView(revision: revision, state: state)
            .overlay {
                if let error = state.error {
                    Text(error).font(.callout).foregroundStyle(.secondary).padding()
                        .frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.background)
                } else if state.loading { ProgressView("Starting sandbox…") }
            }
    }
}

/// The current chat's complete, live artifact index. Renderers only start when a row is opened.
struct SessionArtifactsPane: View {
    let sessionId: String
    @ObservedObject var client: PilotClient
    @StateObject private var state = SessionArtifactsState()

    private var artifacts: [ArtifactSummary] { client.artifacts[sessionId] ?? [] }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text("\(artifacts.count) artifact\(artifacts.count == 1 ? "" : "s")")
                    .font(.system(size: 12, weight: .medium))
                Spacer()
                if state.loading { ProgressView().controlSize(.mini) }
                Button { Task { await load() } } label: {
                    Image(systemName: "arrow.clockwise").font(.caption)
                }
                .buttonStyle(.borderless)
                .disabled(state.loading)
                .help("Refresh artifacts")
                .accessibilityLabel("Refresh artifacts")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            Rectangle().fill(Theme.border).frame(height: 1)
            if let error = state.error {
                VStack(spacing: 8) {
                    Text(error).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                    Button("Retry") { Task { await load() } }.disabled(state.loading)
                }
                .padding()
            }
            if state.loading, artifacts.isEmpty {
                ProgressView("Loading artifacts…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if artifacts.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "cube.transparent").font(.title2).foregroundStyle(Theme.faintForeground)
                    Text(state.error == nil ? "No artifacts yet" : "Artifacts unavailable")
                        .font(.callout).foregroundStyle(Theme.mutedForeground)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(artifacts) { artifact in
                            Button { state.selected = artifact.reference } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: artifact.kind == .image ? "photo" : "cube.transparent")
                                        .foregroundStyle(Theme.mutedForeground)
                                    Text(artifact.title).font(.callout).lineLimit(1)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                    Text("\(artifact.kind.rawValue.uppercased()) · r\(artifact.revision)")
                                        .font(.caption.monospaced()).foregroundStyle(Theme.mutedForeground)
                                }
                                .padding(12)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .help("Open \(artifact.title), latest revision")
                            Rectangle().fill(Theme.border).frame(height: 1)
                        }
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

struct ProjectArtifactsButton: View {
    let project: Project
    @ObservedObject var client: PilotClient
    @StateObject private var state = ArtifactViewState()

    var body: some View {
        Button { state.viewer = true } label: {
            Image(systemName: "cube.transparent")
        }
        .buttonStyle(.borderless)
        .help("Browse artifacts in \(project.name)")
        .accessibilityLabel("Browse artifacts in \(project.name)")
        .sheet(isPresented: $state.viewer) { ProjectArtifactsBrowser(project: project, client: client) }
    }
}

@MainActor
private final class ProjectArtifactsState: ObservableObject {
    @Published var artifacts: [ArtifactSummary] = []
    @Published var selected: ArtifactReference?
    @Published var loading = false
    @Published var error: String?
}

private struct ProjectArtifactsBrowser: View {
    let project: Project
    @ObservedObject var client: PilotClient
    @StateObject private var state = ProjectArtifactsState()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("\(project.name) artifacts").font(.headline)
                Spacer()
                Button("Refresh") { Task { await load() } }
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }.padding()
            Divider()
            if state.loading { ProgressView("Loading artifacts…").padding() }
            if let error = state.error { Text(error).foregroundStyle(.secondary).padding() }
            if !state.loading, state.error == nil, state.artifacts.isEmpty { Text("No artifacts yet").foregroundStyle(.secondary).padding() }
            List(state.artifacts) { artifact in
                HStack {
                    Button { state.selected = artifact.reference } label: {
                        HStack {
                            Label(artifact.title, systemImage: "cube.transparent")
                            Spacer()
                            Text("r\(artifact.revision)").font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                    }.buttonStyle(.plain)
                    Button {
                        AppModel.shared.selectedSessionId = artifact.sessionId
                        dismiss()
                    } label: {
                        Label(client.session(artifact.sessionId)?.title ?? "Open chat", systemImage: "bubble.left")
                            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    .buttonStyle(.borderless)
                    .help("Open originating chat: \(client.session(artifact.sessionId)?.title ?? artifact.sessionId)")
                }
            }
        }
        .frame(minWidth: 580, minHeight: 400)
        .task { await load() }
        .sheet(item: $state.selected) { ArtifactViewer(reference: $0, latest: true) }
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
