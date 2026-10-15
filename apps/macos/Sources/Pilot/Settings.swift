import AppKit
import GhosttyTerminal
import PilotCore
import SwiftUI

/// User preferences, persisted in UserDefaults.
@MainActor
final class AppSettings: ObservableObject {
    static let shared = AppSettings()
    nonisolated static let systemFont = "System"
    nonisolated static let systemMono = "System Monospaced"

    private let defaults = UserDefaults.standard

    @Published var chatFontFamily: String { didSet { defaults.set(chatFontFamily, forKey: "chatFontFamily") } }
    @Published var chatFontSize: Double { didSet { defaults.set(chatFontSize, forKey: "chatFontSize") } }
    @Published var codeFontFamily: String { didSet { defaults.set(codeFontFamily, forKey: "codeFontFamily") } }
    @Published var codeFontSize: Double { didSet { defaults.set(codeFontSize, forKey: "codeFontSize") } }
    /// Empty: whatever the Ghostty config (or libghostty's default) says.
    @Published var terminalFontFamily: String { didSet { defaults.set(terminalFontFamily, forKey: "terminalFontFamily") } }
    /// 0: from the Ghostty config.
    @Published var terminalFontSize: Double { didSet { defaults.set(terminalFontSize, forKey: "terminalFontSize") } }
    @Published var useGhosttyConfig: Bool { didSet { defaults.set(useGhosttyConfig, forKey: "useGhosttyConfig") } }
    @Published var notifyWhenPRReady: Bool { didSet { defaults.set(notifyWhenPRReady, forKey: "notifyWhenPRReady") } }

    init() {
        chatFontFamily = defaults.string(forKey: "chatFontFamily") ?? Self.systemFont
        chatFontSize = defaults.object(forKey: "chatFontSize") as? Double ?? 14
        codeFontFamily = defaults.string(forKey: "codeFontFamily") ?? Self.systemMono
        codeFontSize = defaults.object(forKey: "codeFontSize") as? Double ?? 12
        terminalFontFamily = defaults.string(forKey: "terminalFontFamily") ?? ""
        terminalFontSize = defaults.object(forKey: "terminalFontSize") as? Double ?? 0
        useGhosttyConfig = defaults.object(forKey: "useGhosttyConfig") as? Bool ?? true
        notifyWhenPRReady = defaults.object(forKey: "notifyWhenPRReady") as? Bool ?? false
    }

    var fonts: PilotFonts {
        PilotFonts(chatFamily: chatFontFamily, chatSize: chatFontSize, codeFamily: codeFontFamily, codeSize: codeFontSize)
    }

    var terminalConfiguration: TerminalConfiguration {
        var configuration = TerminalConfiguration()
        if !terminalFontFamily.isEmpty { configuration = configuration.fontFamily(terminalFontFamily) }
        if terminalFontSize > 0 { configuration = configuration.fontSize(Float(terminalFontSize)) }
        return configuration
    }

    func resetFonts() {
        chatFontFamily = Self.systemFont
        chatFontSize = 14
        codeFontFamily = Self.systemMono
        codeFontSize = 12
    }

    static let fontFamilies: [String] = NSFontManager.shared.availableFontFamilies.sorted()

    static let monospacedFamilies: [String] = fontFamilies.filter { family in
        guard let member = NSFontManager.shared.availableMembers(ofFontFamily: family)?.first,
              let name = member.first as? String,
              let font = NSFont(name: name, size: 12)
        else { return false }
        return font.isFixedPitch
    }
}

/// Fonts for chat content, from settings. Read through the environment so changes apply live.
struct PilotFonts: Equatable {
    var chatFamily: String
    var chatSize: Double
    var codeFamily: String
    var codeSize: Double

    static let standard = PilotFonts(chatFamily: AppSettings.systemFont, chatSize: 14, codeFamily: AppSettings.systemMono, codeSize: 12)

    var body: Font { chat(chatSize) }
    var small: Font { chat(chatSize - 1.5) }
    var mono: Font { code(codeSize) }
    var monoSmall: Font { code(codeSize - 0.5) }

    func chat(_ size: Double, weight: Font.Weight = .regular) -> Font {
        chatFamily == AppSettings.systemFont ? .system(size: size, weight: weight) : .custom(chatFamily, size: size).weight(weight)
    }

    func code(_ size: Double) -> Font {
        codeFamily == AppSettings.systemMono ? .system(size: size, design: .monospaced) : .custom(codeFamily, size: size)
    }

    /// AppKit font for text views (chat size).
    var nsBody: NSFont { nsChat(chatSize) }

    var nsMono: NSFont {
        guard codeFamily != AppSettings.systemMono,
              let font = NSFontManager.shared.font(withFamily: codeFamily, traits: [], weight: 5, size: codeSize)
        else { return .monospacedSystemFont(ofSize: codeSize, weight: .regular) }
        return font
    }

    func nsChat(_ size: Double) -> NSFont {
        guard chatFamily != AppSettings.systemFont,
              let font = NSFontManager.shared.font(withFamily: chatFamily, traits: [], weight: 5, size: size)
        else { return .systemFont(ofSize: size) }
        return font
    }

    func nsChat(_ size: Double, weight: NSFont.Weight) -> NSFont {
        let descriptor = nsChat(size).fontDescriptor.addingAttributes([
            .traits: [NSFontDescriptor.TraitKey.weight: weight.rawValue],
        ])
        return NSFont(descriptor: descriptor, size: size) ?? nsChat(size)
    }
}

private struct PilotFontsKey: EnvironmentKey {
    static let defaultValue = PilotFonts.standard
}

extension EnvironmentValues {
    var pilotFonts: PilotFonts {
        get { self[PilotFontsKey.self] }
        set { self[PilotFontsKey.self] = newValue }
    }
}

// MARK: - Settings window

/// A page of the settings window. General pages come first in the sidebar, then one page per project.
enum SettingsTab: Hashable {
    case appearance, notifications, energy, terminal, updates
    case project(String)

    static let general: [SettingsTab] = [.appearance, .notifications, .energy, .terminal, .updates]

    var title: String {
        switch self {
        case .appearance: "Appearance"
        case .notifications: "Notifications"
        case .energy: "Energy"
        case .terminal: "Terminal"
        case .updates: "Updates"
        case .project: "Project"
        }
    }

    var icon: PilotIcon {
        switch self {
        case .appearance: PilotIcon.appearance
        case .notifications: PilotIcon.notifications
        case .energy: PilotIcon.energy
        case .terminal: PilotIcon.terminal
        case .updates: PilotIcon.updates
        case .project: PilotIcon.project
        }
    }
}

/// Sidebar of general pages and projects beside the selected page. Resizable; pages keep a readable column.
struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var client = AppModel.shared.client
    @State private var addError: String?

    var body: some View {
        HStack(spacing: 0) {
            SettingsSidebar(selection: $model.settingsTab, projects: client.projects) {
                Task { await addProject() }
            }
            .frame(width: 210)
            Divider()
            detail
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 640, idealWidth: 780, maxWidth: .infinity, minHeight: 440, idealHeight: 580, maxHeight: .infinity)
        .navigationTitle(title)
        .onChange(of: client.projects) { _, projects in
            // A removed project falls back to the first page.
            if case let .project(id) = model.settingsTab, !projects.contains(where: { $0.id == id }) {
                model.settingsTab = .appearance
            }
        }
        .alert("Couldn't add the project", isPresented: Binding(get: { addError != nil }, set: { if !$0 { addError = nil } })) {
            Button("OK") { addError = nil }
        } message: {
            Text(addError ?? "")
        }
    }

    @ViewBuilder private var detail: some View {
        switch model.settingsTab {
        case .appearance:
            SettingsPage("Appearance", subtitle: "Fonts for chat, code and tool output.") {
                AppearanceDefaultsButton()
            } content: {
                AppearanceSettings()
            }
        case .notifications:
            SettingsPage("Notifications", subtitle: "Pilot only interrupts you for things that need you.") { NotificationSettings() }
        case .energy:
            SettingsPage("Energy", subtitle: "Keep work moving. Let the display rest.") { EnergySettings() }
        case .terminal:
            SettingsPage("Terminal", subtitle: "The chat terminal runs on Ghostty.") { TerminalSettings() }
        case .updates:
            SettingsPage("Updates", subtitle: "Pilot updates itself from private GitHub releases.") { UpdateSettings() }
        case let .project(id):
            if let project = client.projects.first(where: { $0.id == id }) {
                ProjectSettings(project: project).id(project.id)
            } else {
                Text("This project was removed.")
                    .font(.pilot(.body))
                    .foregroundStyle(Theme.mutedForeground)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private var title: String {
        if case let .project(id) = model.settingsTab {
            return client.projects.first { $0.id == id }?.name ?? "Project"
        }
        return model.settingsTab.title
    }

    private func addProject() async {
        guard let path = chooseFolder() else { return }
        do {
            model.settingsTab = .project(try await client.createProject(ProjectRequest(path: path)).id)
        } catch {
            addError = error.localizedDescription
        }
    }
}

private struct SettingsSidebar: View {
    @Binding var selection: SettingsTab
    let projects: [Project]
    let addProject: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            List(selection: Binding(get: { selection }, set: { if let next = $0 { selection = next } })) {
                Section {
                    ForEach(SettingsTab.general, id: \.self) { tab in
                        Label(tab.title, icon: tab.icon).tag(tab)
                    }
                }
                Section("Projects") {
                    ForEach(projects) { project in
                        Label(project.name, icon: PilotIcon.project)
                            .lineLimit(1)
                            .help(project.path.abbreviatingHome)
                            .tag(SettingsTab.project(project.id))
                    }
                    if projects.isEmpty {
                        Text("Add a project to group chats by repository.")
                            .font(.pilot(.caption))
                            .foregroundStyle(Theme.mutedForeground)
                            .fixedSize(horizontal: false, vertical: true)
                            .selectionDisabled()
                    }
                }
            }
            .listStyle(.sidebar)
            Divider()
            Button(action: addProject) {
                Label("Add Project…", icon: PilotIcon.newProject)
                    .font(.pilot(.label))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .foregroundStyle(Theme.mutedForeground)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
        }
    }
}

/// One settings page: a title and a one-line summary over a grouped form, with an optional trailing
/// accessory in the header and a pinned footer for actions such as Save. Content stays within
/// Theme.settingsColumn and centers in wide windows.
struct SettingsPage<Accessory: View, Content: View, Footer: View>: View {
    let title: String
    let subtitle: String
    let accessory: Accessory
    let content: Content
    let footer: Footer

    init(_ title: String, subtitle: String, @ViewBuilder accessory: () -> Accessory,
         @ViewBuilder content: () -> Content, @ViewBuilder footer: () -> Footer) {
        self.title = title
        self.subtitle = subtitle
        self.accessory = accessory()
        self.content = content()
        self.footer = footer()
    }

    var body: some View {
        GeometryReader { proxy in
            let inset = max(0, (proxy.size.width - Theme.settingsColumn) / 2)
            VStack(spacing: 0) {
                PageHeader(title, subtitle: subtitle) { accessory }
                    .padding(.horizontal, 20 + inset)
                    .padding(.top, 20)
                Form { content }
                    .formStyle(.grouped)
                    .scrollContentBackground(.hidden)
                    .contentMargins(.horizontal, inset, for: .scrollContent)
                if Footer.self != EmptyView.self {
                    Divider()
                    footer
                        .padding(.horizontal, 20 + inset)
                        .padding(.vertical, 12)
                }
            }
            .background(Theme.background)
        }
    }
}

extension SettingsPage where Accessory == EmptyView, Footer == EmptyView {
    init(_ title: String, subtitle: String, @ViewBuilder content: () -> Content) {
        self.init(title, subtitle: subtitle, accessory: { EmptyView() }, content: content, footer: { EmptyView() })
    }
}

extension SettingsPage where Footer == EmptyView {
    init(_ title: String, subtitle: String, @ViewBuilder accessory: () -> Accessory, @ViewBuilder content: () -> Content) {
        self.init(title, subtitle: subtitle, accessory: accessory, content: content, footer: { EmptyView() })
    }
}

/// Explanatory text under a settings section, leading-aligned like the rows above it.
struct SettingsFooter: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.pilot(.caption))
            .foregroundStyle(Theme.mutedForeground)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The Appearance page's accessory: puts every font back to the system defaults.
private struct AppearanceDefaultsButton: View {
    @ObservedObject private var settings = AppSettings.shared

    var body: some View {
        Button("Restore Defaults") { settings.resetFonts() }
            .controlSize(.small)
            .disabled(settings.fonts == .standard)
            .help("Use the system fonts and default sizes")
    }
}

private struct AppearanceSettings: View {
    @ObservedObject private var settings = AppSettings.shared

    var body: some View {
        Section("Preview") {
            VStack(alignment: .leading, spacing: 8) {
                Text("The flaky test was a race in the chat reopen path.").font(settings.fonts.body)
                Text("npm test -- --grep reopen").font(settings.fonts.mono)
            }
            .padding(.vertical, 4)
        }
        Section("Chat") {
            FontFamilyPicker(title: "Font", selection: $settings.chatFontFamily, system: AppSettings.systemFont, families: AppSettings.fontFamilies)
            SizeStepper(title: "Size", value: $settings.chatFontSize, range: 11 ... 22)
        }
        Section("Code and tool output") {
            FontFamilyPicker(title: "Font", selection: $settings.codeFontFamily, system: AppSettings.systemMono, families: AppSettings.monospacedFamilies)
            SizeStepper(title: "Size", value: $settings.codeFontSize, range: 9 ... 20)
        }
    }
}

private struct NotificationSettings: View {
    @ObservedObject private var settings = AppSettings.shared

    var body: some View {
        Section {
            Toggle(isOn: $settings.notifyWhenPRReady) {
                Text("Pull request ready to merge")
                Text("Notify when an open pull request has no blockers left. Pilot never merges.")
            }
        } footer: {
            SettingsFooter("Failed chats, unreviewed results and mission questions always show under Needs you, in the sidebar, Inbox and menu bar.")
        }
    }
}

private struct TerminalSettings: View {
    @ObservedObject private var settings = AppSettings.shared

    var body: some View {
        Section {
            Toggle(isOn: $settings.useGhosttyConfig) {
                Text("Use Ghostty config")
                Text("Theme, keybindings and other options come from ~/.config/ghostty/config. The font settings below override it.")
            }
        }
        Section("Font") {
            Picker("Family", selection: $settings.terminalFontFamily) {
                Text("From Ghostty config").tag("")
                Divider()
                ForEach(AppSettings.monospacedFamilies, id: \.self) { Text($0).tag($0) }
            }
            Toggle("Custom size", isOn: Binding(
                get: { settings.terminalFontSize > 0 },
                set: { settings.terminalFontSize = $0 ? 13 : 0 }
            ))
            if settings.terminalFontSize > 0 {
                SizeStepper(title: "Size", value: $settings.terminalFontSize, range: 8 ... 28, step: 1)
            }
        }
    }
}

private struct FontFamilyPicker: View {
    let title: String
    @Binding var selection: String
    let system: String
    let families: [String]

    var body: some View {
        Picker(title, selection: $selection) {
            Text(system).tag(system)
            Divider()
            ForEach(families, id: \.self) { Text($0).tag($0) }
        }
    }
}

private struct SizeStepper: View {
    let title: String
    @Binding var value: Double
    let range: ClosedRange<Double>
    var step: Double = 0.5

    var body: some View {
        Stepper(value: $value, in: range, step: step) {
            HStack {
                Text(title)
                Spacer()
                Text("\(value, specifier: value.rounded() == value ? "%.0f" : "%.1f") pt")
                    .monospacedDigit()
                    .foregroundStyle(Theme.mutedForeground)
            }
        }
    }
}

@MainActor
final class ProjectEditor: ObservableObject {
    @Published var name = ""
    @Published var model = ""
    @Published var privateClones = true
    @Published var requirePullRequest = true
    @Published var slackChannels: [TrackedChannelRef] = []
    @Published var slackLabels: [EditableSlackLabel] = []
    @Published var linearTeam: TrackedTeamRef?
    @Published var linearStateMappings: [String: LinearStateMapping] = [:]
    @Published var error: String?
    @Published private var loaded: Fields?

    /// The editable values, to tell whether there is anything to save.
    private struct Fields: Equatable {
        var name: String
        var model: String
        var privateClones: Bool
        var requirePullRequest: Bool
        var channels: [String]
        var team: String?
        var stateMappings: [String: LinearStateMapping]
        var labels: [SlackProjectLabel]
    }

    private var fields: Fields {
        Fields(name: name, model: model, privateClones: privateClones, requirePullRequest: requirePullRequest,
               channels: slackChannels.map(\.id), team: linearTeam?.id, stateMappings: linearStateMappings, labels: savedLabels)
    }

    /// Labels as saved. Unnamed labels are drafts and are left out.
    private var savedLabels: [SlackProjectLabel] {
        slackLabels.map(\.label).filter { !$0.name.isEmpty }
    }

    var hasChanges: Bool { loaded != nil && loaded != fields }

    func load(_ project: Project) {
        name = project.name
        model = project.model ?? ""
        privateClones = project.usesPrivateClones
        requirePullRequest = project.effectiveRequirePullRequest
        let tracking = project.tracking
        slackLabels = (tracking?.slackLabels ?? []).map(EditableSlackLabel.init)
        slackChannels = (tracking?.slackChannels ?? []).map { TrackedChannelRef(id: $0, name: tracking?.slackChannelNames?[$0]) }
        linearTeam = tracking?.linearTeam.flatMap { $0.isEmpty ? nil : TrackedTeamRef(id: $0, name: tracking?.linearTeamName) }
        linearStateMappings = tracking?.linearStateMappings ?? [:]
        error = nil
        loaded = fields
    }

    func addChannel(_ option: SlackChannelOption) {
        guard !slackChannels.contains(where: { $0.id == option.id }) else { return }
        slackChannels.append(TrackedChannelRef(id: option.id, name: option.name))
    }

    func removeChannel(_ id: String) {
        slackChannels.removeAll { $0.id == id }
    }

    func addLabel() {
        slackLabels.append(EditableSlackLabel(SlackProjectLabel(name: "", description: "")))
    }

    func removeLabel(_ id: UUID) {
        slackLabels.removeAll { $0.id == id }
    }

    var request: ProjectRequest {
        let names = Dictionary(slackChannels.compactMap { channel in channel.name.map { (channel.id, $0) } },
                               uniquingKeysWith: { first, _ in first })
        let labels = savedLabels
        return ProjectRequest(
            name: name, model: model, workspace: privateClones ? "clone" : "direct",
            requirePullRequest: requirePullRequest,
            tracking: ProjectTrackingConfig(
                slackChannels: slackChannels.map(\.id),
                slackChannelNames: names.isEmpty ? nil : names,
                linearTeam: linearTeam?.id ?? "",
                linearTeamName: linearTeam?.name,
                slackLabels: labels.isEmpty ? nil : labels,
                linearStateMappings: linearTeam == nil || linearStateMappings.isEmpty ? nil : linearStateMappings
            )
        )
    }
}

/// One project's settings. Edits stay local until Save; Remove keeps the sessions and the folder.
private struct ProjectSettings: View {
    let project: Project
    @ObservedObject private var client = AppModel.shared.client
    @StateObject private var editor = ProjectEditor()
    @State private var saving = false
    @State private var confirmingRemoval = false

    var body: some View {
        SettingsPage(project.name, subtitle: project.path.abbreviatingHome) {
            Button("Show in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting([URL(filePath: project.path)])
            }
            .controlSize(.small)
        } content: {
            Section("General") {
                TextField("Name", text: $editor.name)
                TextField("Default model", text: $editor.model, prompt: Text("pi default"))
            }
            Section("Workspace") {
                Toggle(isOn: $editor.privateClones) {
                    Text("Isolated workspace per chat")
                    Text("Chats get their own working copy, so they never touch your checkout. Turn off to run in the folder itself.")
                }
                Toggle(isOn: $editor.requirePullRequest) {
                    Text("Require a pull request")
                    Text("Publish changes through a pull request. Turning this off allows direct pushes to the default branch. Applies when a chat next starts working.")
                }
            }
            TrackingSettingsSection(project: project, editor: editor)
        } footer: {
            HStack(spacing: 12) {
                Button("Remove Project…", role: .destructive) { confirmingRemoval = true }
                if let error = editor.error {
                    InlineProblem(error)
                        .lineLimit(2)
                        .help(error)
                }
                Spacer(minLength: 8)
                if editor.hasChanges {
                    Button("Revert") { editor.load(project) }
                }
                Button("Save") { Task { await save() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!editor.hasChanges || saving)
            }
        }
        .onAppear { editor.load(project) }
        .onChange(of: project) { _, updated in editor.load(updated) }
        .confirmationDialog("Remove \(project.name)?", isPresented: $confirmingRemoval) {
            Button("Remove Project", role: .destructive) { Task { await remove() } }
        } message: {
            Text("Its chats are kept and the folder on disk is not changed.")
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            _ = try await client.updateProject(project.id, editor.request)
            editor.error = nil
        } catch {
            editor.error = error.localizedDescription
        }
    }

    private func remove() async {
        do {
            try await client.deleteProject(project.id)
        } catch {
            editor.error = error.localizedDescription
        }
    }
}

@MainActor
func chooseFolder(startingAt path: String? = nil) -> String? {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.prompt = "Choose"
    if let path, !path.isEmpty { panel.directoryURL = URL(filePath: (path as NSString).expandingTildeInPath) }
    return panel.runModal() == .OK ? panel.url?.path : nil
}
