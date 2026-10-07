import AppKit
import PilotCore
import SwiftUI

@MainActor
final class NewSessionForm: ObservableObject {
    @Published var model = ""
    @Published var message = ""
    /// A folder outside any project.
    @Published var folder = ""
    @Published var error: String?
    @Published var busy = false
    @Published var tab: ComposerTab = .newTask
    @Published var editorHeight: CGFloat = 60
    @Published var models = ModelList(models: [])
}

enum ComposerTab: Hashable {
    case newTask
    case running
}

/// Home: a sky band, the task composer, and a dashboard of what agents are doing.
struct HomeView: View {
    @EnvironmentObject private var app: AppModel
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        ScrollView {
            ZStack(alignment: .top) {
                DitherSky()
                    .frame(height: 300)
                VStack(spacing: 0) {
                    Text("What should Pilot work on?")
                        .font(.system(size: 24, weight: .semibold))
                        .tracking(-0.3)
                        .foregroundStyle(Theme.foreground)
                        .shadow(color: .white, radius: 6)
                        .shadow(color: .white, radius: 16)
                        .padding(.top, 196)
                        .padding(.bottom, 16)
                    TaskComposer()
                        .frame(maxWidth: 640)
                    Dashboard()
                        .frame(maxWidth: 1180)
                        .padding(.top, 48)
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 40)
            }
        }
        .background(Theme.background)
    }
}

/// "New task" composer with a "Running" tab, as on Berth's home.
struct TaskComposer: View {
    @EnvironmentObject private var app: AppModel
    @ObservedObject private var client = AppModel.shared.client
    @Environment(\.pilotFonts) private var fonts
    @AppStorage("lastProjectId") private var lastProjectId = ""
    @StateObject private var form = NewSessionForm()
    @FocusState private var focused: Bool

    private var project: Project? {
        client.project(app.draftProjectId) ?? (form.folder.isEmpty ? client.project(lastProjectId) ?? client.projects.first : nil)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 14) {
                TabButton(title: "New task", selected: form.tab == .newTask) { form.tab = .newTask }
                TabButton(title: "Running", count: client.workingCount, selected: form.tab == .running) { form.tab = .running }
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.top, 9)
            .padding(.bottom, 7)

            if form.tab == .newTask {
                newTask
            } else {
                RunningList(sessions: client.activeSessions.filter(\.isWorking))
                    .frame(minHeight: 120, alignment: .top)
            }
        }
        // Opaque, so the sky's dissolving dots never show through.
        .background(RoundedRectangle(cornerRadius: 14).fill(Color(hex: 0xF5F5F5)))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.border))
        .task(id: modelScopeKey) { await loadModels() }
    }

    private var newTask: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .topLeading) {
                if form.message.isEmpty {
                    Text("Describe a task, a bug to fix, an idea to try…")
                        .font(fonts.body)
                        .foregroundStyle(Theme.faintForeground)
                        .allowsHitTesting(false)
                }
                ChatTextEditor(text: $form.message, height: $form.editorHeight, font: fonts.nsBody, minLines: 3, maxLines: 14) { _ in
                    start()
                }
                .frame(height: form.editorHeight)
            }
                .padding(12)
                .card(radius: 10)
                .padding(.horizontal, 4)
            HStack(spacing: 6) {
                ProjectMenu(selected: project, folder: form.folder, projects: client.projects) { choice in
                    switch choice {
                    case let .project(id):
                        app.draftProjectId = id
                        form.folder = ""
                    case .folder:
                        if let path = chooseFolder(startingAt: form.folder) {
                            form.folder = path
                            app.draftProjectId = nil
                            lastProjectId = ""
                        }
                    case .addProject:
                        app.addProject()
                    }
                }
                ModelMenu(model: $form.model, projectDefault: project?.model, list: form.models)
                if let error = form.error {
                    Text(error).font(.caption).foregroundStyle(Theme.destructive).lineLimit(1)
                }
                Spacer()
                if form.busy { ProgressView().controlSize(.small) }
                Button(action: start) { Image(systemName: "arrow.up") }
                    .buttonStyle(CircleIconButtonStyle())
                    .disabled(!canStart)
                    .help("Start session (↩)")
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 8)
        }
    }

    private var canStart: Bool {
        !form.busy && (project != nil || !form.folder.isEmpty)
            && !form.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Reloads the pi model scope when the project or folder changes.
    private var modelScopeKey: String { project?.id ?? form.folder }

    private func loadModels() async {
        form.models = (try? await client.models(projectId: project?.id, cwd: project == nil ? form.folder : nil)) ?? ModelList(models: [])
    }

    private func start() {
        guard canStart else { return }
        form.busy = true
        form.error = nil
        let model = form.model.trimmingCharacters(in: .whitespaces)
        let request = SpawnRequest(
            projectId: project?.id,
            cwd: project == nil ? form.folder : nil,
            message: form.message,
            model: model.isEmpty ? nil : model
        )
        Task {
            defer { form.busy = false }
            do {
                let session = try await app.client.spawn(request)
                if let id = project?.id { lastProjectId = id }
                form.message = ""
                app.selectedSessionId = session.id
            } catch {
                form.error = error.localizedDescription
            }
        }
    }
}

private struct TabButton: View {
    let title: String
    var count: Int = 0
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Text(title)
                if count > 0 {
                    Text("\(count)").foregroundStyle(Theme.faintForeground)
                }
            }
            .font(.system(size: 12, weight: selected ? .semibold : .regular))
            .foregroundStyle(selected ? Theme.foreground : Theme.mutedForeground)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct RunningList: View {
    let sessions: [SessionSummary]
    @EnvironmentObject private var app: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if sessions.isEmpty {
                Text("No agents are running.")
                    .font(.callout)
                    .foregroundStyle(Theme.mutedForeground)
                    .frame(maxWidth: .infinity, minHeight: 100)
            }
            ForEach(sessions) { session in
                Button { app.selectedSessionId = session.id } label: {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.mini)
                        Text(session.title).lineLimit(1)
                        Spacer()
                        Text(app.client.project(session.projectId)?.name ?? URL(filePath: session.cwd).lastPathComponent)
                            .foregroundStyle(Theme.mutedForeground)
                    }
                    .font(.system(size: 13))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .card(radius: 10)
        .padding(.horizontal, 4)
        .padding(.bottom, 4)
    }
}

enum ProjectChoice {
    case project(String)
    case folder
    case addProject
}

struct ProjectMenu: View {
    let selected: Project?
    let folder: String
    let projects: [Project]
    let choose: (ProjectChoice) -> Void

    var body: some View {
        Menu {
            ForEach(projects) { project in
                Button {
                    choose(.project(project.id))
                } label: {
                    if project.id == selected?.id { Label(project.name, systemImage: "checkmark") } else { Text(project.name) }
                }
            }
            if !projects.isEmpty { Divider() }
            Button("Other Folder…") { choose(.folder) }
            Button("Add Project…") { choose(.addProject) }
        } label: {
            ChipLabel(
                title: selected?.name ?? (folder.isEmpty ? "Choose project" : URL(filePath: folder).lastPathComponent),
                icon: "folder"
            )
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
    }
}

struct ModelMenu: View {
    @Binding var model: String
    /// The project's default model, else pi's default.
    let projectDefault: String?
    let list: ModelList

    private var fallback: String? { projectDefault ?? list.defaultModel }

    var body: some View {
        Menu {
            Button {
                model = ""
            } label: {
                let name = fallback.map(displayName) ?? "pi settings"
                if model.isEmpty { Label("Default (\(name))", systemImage: "checkmark") } else { Text("Default (\(name))") }
            }
            ForEach(groups, id: \.provider) { group in
                Section(group.provider) {
                    ForEach(group.models) { option in
                        Button {
                            model = option.id
                        } label: {
                            if model == option.id { Label(option.name, systemImage: "checkmark") } else { Text(option.name) }
                        }
                    }
                }
            }
        } label: {
            ChipLabel(title: displayName(model.isEmpty ? fallback ?? "Default model" : model), icon: "cpu", dot: Theme.warning)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Models from your pi scope (enabledModels)")
    }

    private var groups: [(provider: String, models: [ModelOption])] {
        var order: [String] = []
        var byProvider: [String: [ModelOption]] = [:]
        for option in list.models {
            if byProvider[option.provider] == nil { order.append(option.provider) }
            byProvider[option.provider, default: []].append(option)
        }
        return order.map { ($0, byProvider[$0] ?? []) }
    }

    private func displayName(_ id: String) -> String {
        list.models.first { $0.id == id }?.name ?? (id.split(separator: "/").last.map(String.init) ?? id)
    }
}
