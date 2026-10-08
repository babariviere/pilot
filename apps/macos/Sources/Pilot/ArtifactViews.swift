import AppKit
import PilotCore
import SwiftUI

@MainActor
final class ArtifactViewState: ObservableObject {
    @Published var preview = true
    @Published var visible = false
    @Published var viewer = false
    @Published var source = false
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
    @StateObject private var state = ArtifactViewState()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if state.preview, state.visible {
                ArtifactContent(reference: reference, latest: false, inline: true, onOpen: { state.viewer = true })
                    .frame(height: 240)
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
        .sheet(isPresented: $state.viewer) { ArtifactViewer(reference: reference, latest: false) }
    }
}

struct ArtifactViewer: View {
    let reference: ArtifactReference
    let latest: Bool
    @Environment(\.dismiss) private var dismiss

    private var expandedSize: CGSize {
        ArtifactViewerLayout.size(available: NSApp.keyWindow?.screen?.visibleFrame.size
            ?? NSScreen.main?.visibleFrame.size ?? CGSize(width: 1440, height: 900))
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(reference.title).font(.headline).lineLimit(1)
                Text(latest ? "Latest revision" : "Revision \(reference.revision)").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            .padding(14)
            Divider()
            ArtifactContent(reference: reference, latest: latest)
        }
        .frame(width: expandedSize.width, height: expandedSize.height)
    }
}

private struct ArtifactContent: View {
    let reference: ArtifactReference
    let latest: Bool
    var inline = false
    var onOpen: (() -> Void)?
    @StateObject private var state = ArtifactViewState()

    var body: some View {
        VStack(spacing: 0) {
            if !inline {
                HStack {
                    if let revision = state.revision {
                        Text("\(revision.kind.rawValue.uppercased()) · r\(revision.revision)")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if state.revision?.kind != .image {
                        Picker("View", selection: $state.source) {
                            Text("Preview").tag(false)
                            Text("Source").tag(true)
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .frame(width: 160)
                    }
                }
                .padding(8)
            }
            if state.loading {
                ProgressView("Loading artifact…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = state.error {
                VStack(spacing: 8) {
                    Text(error).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                    Button("Retry") { Task { await state.load(reference, latest: latest) } }
                }
                .padding().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let revision = state.revision {
                if state.source, revision.kind != .image {
                    ScrollView {
                        CodeBlock(language: revision.kind == .react ? "jsx" : "html", text: revision.source)
                    }
                } else {
                    ArtifactPreview(revision: revision).id("\(revision.id)-\(revision.revision)")
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
        }
        .task { await state.load(reference, latest: latest) }
        .background(Theme.background)
    }
}

private struct ArtifactPreview: View {
    let revision: ArtifactRevision
    @StateObject private var state = ArtifactRenderState()

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

/// Session access lives in the navigation sidebar. It never eagerly starts a renderer.
struct SessionArtifactsSection: View {
    let sessionId: String
    @ObservedObject var client: PilotClient
    @StateObject private var state = ArtifactSidebarState()

    var body: some View {
        Section("Artifacts") {
            if state.loading { ProgressView().controlSize(.small) }
            if let error = state.error {
                Text(error).font(.caption).foregroundStyle(.secondary)
                Button("Retry") { Task { await load() } }
            }
            ForEach(client.artifacts[sessionId] ?? []) { artifact in
                Button { state.selected = artifact.reference } label: {
                    Label(artifact.title, systemImage: "cube.transparent").lineLimit(1)
                }
                .buttonStyle(.plain)
                .help("\(artifact.title), revision \(artifact.revision)")
            }
            if !state.loading, state.error == nil, (client.artifacts[sessionId] ?? []).isEmpty {
                Text("No artifacts yet").font(.caption).foregroundStyle(.secondary)
            }
        }
        .task(id: sessionId) { await load() }
        .sheet(item: $state.selected) { reference in ArtifactViewer(reference: reference, latest: true) }
    }

    private func load() async {
        state.loading = true
        state.error = nil
        do { _ = try await client.sessionArtifacts(sessionId) }
        catch { if !Task.isCancelled { state.error = error.localizedDescription } }
        if !Task.isCancelled { state.loading = false }
    }
}

@MainActor
private final class ArtifactSidebarState: ObservableObject {
    @Published var selected: ArtifactReference?
    @Published var loading = false
    @Published var error: String?
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
