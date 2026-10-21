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
    /// Light, dark, or following the system. Applied app-wide through `NSApp.appearance`.
    @Published var appearance: AppearanceMode {
        didSet {
            defaults.set(appearance.rawValue, forKey: "appearance")
            applyAppearance()
        }
    }

    init() {
        chatFontFamily = defaults.string(forKey: "chatFontFamily") ?? Self.systemFont
        chatFontSize = defaults.object(forKey: "chatFontSize") as? Double ?? 14
        codeFontFamily = defaults.string(forKey: "codeFontFamily") ?? Self.systemMono
        codeFontSize = defaults.object(forKey: "codeFontSize") as? Double ?? 12
        terminalFontFamily = defaults.string(forKey: "terminalFontFamily") ?? ""
        terminalFontSize = defaults.object(forKey: "terminalFontSize") as? Double ?? 0
        useGhosttyConfig = defaults.object(forKey: "useGhosttyConfig") as? Bool ?? true
        notifyWhenPRReady = defaults.object(forKey: "notifyWhenPRReady") as? Bool ?? false
        appearance = defaults.string(forKey: "appearance").flatMap(AppearanceMode.init(rawValue:)) ?? .system
    }

    func applyAppearance() {
        NSApp.appearance = appearance.nsAppearance
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

/// The app's appearance setting. `system` follows macOS, including automatic light and dark switching.
enum AppearanceMode: String, CaseIterable, Identifiable {
    case system, light, dark

    var id: Self { self }

    var title: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    var nsAppearance: NSAppearance? {
        switch self {
        case .system: nil
        case .light: NSAppearance(named: .aqua)
        case .dark: NSAppearance(named: .darkAqua)
        }
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
    case appearance, notifications, connections, models, diagnostics, energy, terminal, updates
    case project(String)

    static let general: [SettingsTab] = [.appearance, .notifications, .connections, .models, .diagnostics, .energy, .terminal, .updates]

    /// The sidebar's order: general pages, then projects.
    static func ordered(projects: [Project]) -> [SettingsTab] { general + projects.map { .project($0.id) } }

    /// The page arrow keys move to, stopping at either end.
    static func moving(from tab: SettingsTab, by offset: Int, in order: [SettingsTab]) -> SettingsTab {
        guard let index = order.firstIndex(of: tab) else { return order.first ?? tab }
        return order[min(max(index + offset, 0), order.count - 1)]
    }

    var title: String {
        switch self {
        case .appearance: "Appearance"
        case .notifications: "Notifications"
        case .connections: "Connections"
        case .models: "Scoped models"
        case .diagnostics: "Diagnostics"
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
        case .connections: PilotIcon.connections
        case .models: PilotIcon.model
        case .diagnostics: PilotIcon.activity
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
    @EndpointClient private var client
    @State private var addError: String?

    var body: some View {
        HStack(spacing: 0) {
            SettingsSidebar(selection: $model.settingsTab, projects: client.projects) {
                Task { await addProject() }
            }
            .frame(width: 210)
            Rectangle().fill(Theme.border).frame(width: 1)
            detail
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 640, idealWidth: 780, maxWidth: .infinity, minHeight: 440, idealHeight: 580, maxHeight: .infinity)
        .navigationTitle(title)
        .onChange(of: client.projects) { _, projects in
            // A removed project falls back to the first page.
            if case let .project(id) = model.settingsTab, !id.hasPrefix("hostref1:"), !projects.contains(where: { $0.id == id }) {
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
            SettingsPage("Appearance", subtitle: "Theme and fonts for chat, code and tool output.") {
                AppearanceDefaultsButton()
            } content: {
                AppearanceSettings()
            }
        case .notifications:
            SettingsPage("Notifications", subtitle: "Pilot only interrupts you for things that need you.") { NotificationSettings() }
        case .connections:
            SettingsPage("Connections", subtitle: "MCP servers and sign-in on this Mac.") {
                ConnectionSettings()
            }
        case .models:
            ScopedModelsSettings(hosts: model.hosts, localHost: model.localHost)
        case .diagnostics:
            TelemetrySettingsPage()
        case .energy:
            SettingsPage("Energy", subtitle: "Keep work moving. Let the display rest.") { EnergySettings() }
        case .terminal:
            SettingsPage("Terminal", subtitle: "The chat terminal runs on Ghostty.") { TerminalSettings() }
        case .updates:
            SettingsPage("Updates", subtitle: "Pilot updates itself from private GitHub releases.") { UpdateSettings() }
        case let .project(id):
            if let ref = model.resourceRef(id, kind: .project), ref.host != model.localHost,
               let project = model.hosts.projects.first(where: { $0.ref == ref })?.value {
                ProjectSettings(project: project)
                    .environment(\.hostViewContext, HostViewContext(host: ref.host, hosts: model.hosts)).id(ref.storageKey)
            } else if let project = client.projects.first(where: { $0.id == (model.resourceRef(id, kind: .project)?.localId ?? id) }) {
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

/// The settings sidebar in the main window's style: the sidebar colour, grey line icons and the soft selection fill,
/// with the general pages, then the projects and Add Project at the bottom.
private struct SettingsSidebar: View {
    @Binding var selection: SettingsTab
    let projects: [Project]
    let addProject: () -> Void
    /// The sidebar takes focus when Settings opens: arrows move between pages, as in the main sidebar.
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(SettingsTab.general, id: \.self) { tab in
                        row(tab.title, icon: tab.icon, tab: tab)
                    }
                    SectionLabel(title: "Projects")
                        .padding(.horizontal, 8)
                        .padding(.top, 14)
                        .padding(.bottom, 4)
                    ForEach(projects) { project in
                        row(project.name, icon: PilotIcon.project, tab: .project(project.id),
                            help: project.path.abbreviatingHome)
                    }
                    if projects.isEmpty {
                        Text("Add a project to group chats by repository.")
                            .font(.pilot(.caption))
                            .foregroundStyle(Theme.mutedForeground)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, 8)
                    }
                }
                .padding(10)
                .focusable()
                .focused($focused)
                .focusEffectDisabled()
                .onKeyPress(keys: [.upArrow, .downArrow, .home, .end]) { press in
                    guard press.modifiers.isDisjoint(with: [.command, .control, .option]) else { return .ignored }
                    let order = SettingsTab.ordered(projects: projects)
                    switch press.key {
                    case .home: selection = order.first ?? selection
                    case .end: selection = order.last ?? selection
                    default: selection = SettingsTab.moving(from: selection, by: press.key == .upArrow ? -1 : 1, in: order)
                    }
                    return .handled
                }
            }
            HairlineDivider()
            Button(action: addProject) {
                Label("Add Project…", icon: PilotIcon.newProject)
                    .font(.pilot(.label))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .rowButtonStyle()
            .foregroundStyle(Theme.mutedForeground)
            .padding(.horizontal, 18)
            .padding(.vertical, 9)
        }
        .background(Theme.sidebar)
        .onAppear { DispatchQueue.main.async { focused = true } }
    }

    private func row(_ title: String, icon: PilotIcon, tab: SettingsTab, help: String? = nil) -> some View {
        SidebarNavRow(title: title, icon: icon, selected: selection == tab, help: help,
                      parentFocused: focused, action: { selection = tab; focused = true }) {
            if tab == .connections { ConnectionsTabBadge() }
        }
    }
}

/// One settings page: a title and a one-line summary, then sections, in one white reading column
/// (Theme.settingsColumn, centered in wide windows) that scrolls with its header. A page with unsaved edits adds its
/// own Save bar with `safeAreaInset(edge: .bottom)`.
struct SettingsPage<Accessory: View, Content: View>: View {
    let title: String
    let subtitle: String
    let accessory: Accessory
    let content: Content

    init(_ title: String, subtitle: String, @ViewBuilder accessory: () -> Accessory, @ViewBuilder content: () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.accessory = accessory()
        self.content = content()
    }

    var body: some View {
        SettingsColumn {
            PageHeader(title, subtitle: subtitle) { accessory }
            content
        }
    }
}

extension SettingsPage where Accessory == EmptyView {
    init(_ title: String, subtitle: String, @ViewBuilder content: () -> Content) {
        self.init(title, subtitle: subtitle, accessory: { EmptyView() }, content: content)
    }
}

/// The scrolling reading column of a settings page, also used on its own by snapshots of single sections.
struct SettingsColumn<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) { content }
                .padding(.horizontal, 20)
                .padding(.top, 20)
                .padding(.bottom, 28)
                .frame(maxWidth: Theme.settingsColumn, alignment: .leading)
                .frame(maxWidth: .infinity)
        }
        .background(Theme.background)
    }
}

/// A section of a settings page: a semibold heading, its explanation as a muted caption above the rows, then hairline
/// rows (`SettingsRow`, `SettingsToggle`) aligned to the heading. Both heading and explanation are optional.
struct SettingsSection<Content: View>: View {
    let title: String?
    let explanation: String?
    let content: Content

    init(_ title: String? = nil, explanation: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.explanation = explanation
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if title != nil || explanation != nil {
                VStack(alignment: .leading, spacing: 3) {
                    if let title {
                        Text(title)
                            .font(.pilot(.body, weight: .semibold))
                            .foregroundStyle(Theme.foreground)
                            .accessibilityAddTraits(.isHeader)
                    }
                    if let explanation { SettingsNote(explanation) }
                }
                .padding(.bottom, 8)
            }
            content
            HairlineDivider()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One hairline row of a settings section: leading text and a trailing control, vertically centred. Pass only content
/// for a full-width row, such as a status line, an inline problem or a quiet button.
struct SettingsRow<Leading: View, Control: View>: View {
    let leading: Leading
    let control: Control

    init(@ViewBuilder label: () -> Leading, @ViewBuilder control: () -> Control) {
        leading = label()
        self.control = control()
    }

    var body: some View {
        VStack(spacing: 0) {
            HairlineDivider()
            HStack(alignment: .center, spacing: 16) {
                leading.frame(maxWidth: .infinity, alignment: .leading)
                control
            }
            .padding(.vertical, 9)
        }
    }
}

extension SettingsRow where Leading == SettingsRowLabel {
    init(_ title: String, detail: String? = nil, @ViewBuilder control: () -> Control) {
        self.init(label: { SettingsRowLabel(title: title, detail: detail) }, control: control)
    }
}

extension SettingsRow where Control == EmptyView {
    init(@ViewBuilder content: () -> Leading) {
        self.init(label: content, control: { EmptyView() })
    }
}

/// A settings row's title and optional muted detail, which wraps. Fades with the row when disabled.
struct SettingsRowLabel: View {
    let title: String
    var detail: String?
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.pilot(.body))
                .foregroundStyle(isEnabled ? Theme.foreground : Theme.faintForeground)
                .fixedSize(horizontal: false, vertical: true)
            if let detail, !detail.isEmpty {
                Text(detail)
                    .font(.pilot(.caption))
                    .foregroundStyle(Theme.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// A settings row with a trailing switch.
struct SettingsToggle: View {
    let title: String
    var detail: String?
    @Binding var isOn: Bool

    init(_ title: String, detail: String? = nil, isOn: Binding<Bool>) {
        self.title = title
        self.detail = detail
        _isOn = isOn
    }

    var body: some View {
        SettingsRow(title, detail: detail) {
            Toggle(title, isOn: $isOn)
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
                .accessibilityHint(detail ?? "")
        }
    }
}

/// Explanatory muted caption in settings, such as a section's explanation or a note under its rows.
struct SettingsNote: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.pilot(.caption))
            .foregroundStyle(Theme.mutedForeground)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A heading between groups of rows inside one settings section, such as "Triage guide" and "Recent corrections"
/// under Slack labels: medium body text, an optional muted note, and an optional small control (such as Rebuild)
/// trailing on the title's baseline. Lighter than a section heading, so the rows still read as one section.
struct SettingsSubheading<Accessory: View>: View {
    let title: String
    let note: String?
    let accessory: Accessory

    init(_ title: String, note: String? = nil, @ViewBuilder accessory: () -> Accessory) {
        self.title = title
        self.note = note
        self.accessory = accessory()
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.pilot(.body, weight: .medium))
                    .foregroundStyle(Theme.foreground)
                    .accessibilityAddTraits(.isHeader)
                if let note { SettingsNote(note) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            accessory
        }
        .padding(.top, 18)
        .padding(.bottom, 8)
    }
}

extension SettingsSubheading where Accessory == EmptyView {
    init(_ title: String, note: String? = nil) {
        self.init(title, note: note) { EmptyView() }
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
        SettingsSection("Theme") {
            SettingsRow("Appearance", detail: "System follows macOS, including its automatic switching.") {
                Picker("Appearance", selection: $settings.appearance) {
                    ForEach(AppearanceMode.allCases) { Text($0.title).tag($0) }
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .fixedSize()
            }
        }
        SettingsSection("Preview") {
            SettingsRow {
                VStack(alignment: .leading, spacing: 8) {
                    Text("The flaky test was a race in the chat reopen path.").font(settings.fonts.body)
                    Text("npm test -- --grep reopen").font(settings.fonts.mono)
                }
                .foregroundStyle(Theme.foreground)
                .padding(.vertical, 4)
            }
        }
        SettingsSection("Chat") {
            FontFamilyPicker(title: "Font", selection: $settings.chatFontFamily, system: AppSettings.systemFont, families: AppSettings.fontFamilies)
            SizeStepper(title: "Size", value: $settings.chatFontSize, range: 11 ... 22)
        }
        SettingsSection("Code and tool output") {
            FontFamilyPicker(title: "Font", selection: $settings.codeFontFamily, system: AppSettings.systemMono, families: AppSettings.monospacedFamilies)
            SizeStepper(title: "Size", value: $settings.codeFontSize, range: 9 ... 20)
        }
    }
}

private struct NotificationSettings: View {
    @ObservedObject private var settings = AppSettings.shared

    var body: some View {
        SettingsSection(explanation: "Failed chats, unreviewed results and mission questions always show under Needs you, in the sidebar, Inbox and menu bar.") {
            SettingsToggle("Pull request ready to merge",
                           detail: "Notify when an open pull request has no blockers left. Pilot never merges.",
                           isOn: $settings.notifyWhenPRReady)
        }
    }
}

private struct TerminalSettings: View {
    @ObservedObject private var settings = AppSettings.shared

    var body: some View {
        SettingsSection {
            SettingsToggle("Use Ghostty config",
                           detail: "Theme, keybindings and other options come from ~/.config/ghostty/config. The font settings below override it.",
                           isOn: $settings.useGhosttyConfig)
        }
        SettingsSection("Font") {
            SettingsRow("Family") {
                Picker("Family", selection: $settings.terminalFontFamily) {
                    Text("From Ghostty config").tag("")
                    Divider()
                    ForEach(AppSettings.monospacedFamilies, id: \.self) { Text($0).tag($0) }
                }
                .labelsHidden()
                .fixedSize()
            }
            SettingsToggle("Custom size", isOn: Binding(
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
        SettingsRow(title) {
            Picker(title, selection: $selection) {
                Text(system).tag(system)
                Divider()
                ForEach(families, id: \.self) { Text($0).tag($0) }
            }
            .labelsHidden()
            .fixedSize()
        }
    }
}

private struct SizeStepper: View {
    let title: String
    @Binding var value: Double
    let range: ClosedRange<Double>
    var step: Double = 0.5

    var body: some View {
        SettingsRow(title) {
            HStack(spacing: 6) {
                Text("\(value, specifier: value.rounded() == value ? "%.0f" : "%.1f") pt")
                    .font(.pilot(.body))
                    .monospacedDigit()
                    .foregroundStyle(Theme.mutedForeground)
                Stepper(title, value: $value, in: range, step: step)
                    .labelsHidden()
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
    @Published var slackMentionOnlyChannels: Set<String> = []
    @Published var slackGroupHandles = ""
    @Published var slackLabels: [EditableSlackLabel] = []
    @Published var linearTeam: TrackedTeamRef?
    @Published var linearStateMappings: [String: LinearStateMapping] = [:]
    @Published var error: String?
    @Published private var loaded: Fields?
    /// The newest project value seen from the server. Fields only follow it while the form has no unsaved edits.
    @Published private(set) var latest: Project?
    @Published private(set) var isSaving = false
    /// Changes when the editor moves to another project, so a late save response cannot touch the new form.
    private var generation = 0
    /// The last project value that arrived while a save was in flight. Project has no version, so its order against
    /// the save response is unknown.
    private var observedDuringSave: Project?
    /// A save response was set aside because a different value arrived while it was in flight.
    private var setAsideResponse = false

    /// The editable values, to tell whether there is anything to save.
    private struct Fields: Equatable {
        var name: String
        var model: String
        var privateClones: Bool
        var requirePullRequest: Bool
        var channels: [String]
        var mentionOnlyChannels: Set<String>
        var groupHandles: String
        var team: String?
        var stateMappings: [String: LinearStateMapping]
        var labels: [SlackProjectLabel]

        init(name: String, model: String, privateClones: Bool, requirePullRequest: Bool, channels: [String],
             mentionOnlyChannels: Set<String>, groupHandles: String, team: String?,
             stateMappings: [String: LinearStateMapping], labels: [SlackProjectLabel]) {
            self.name = name; self.model = model; self.privateClones = privateClones
            self.requirePullRequest = requirePullRequest; self.channels = channels
            self.mentionOnlyChannels = mentionOnlyChannels; self.groupHandles = groupHandles; self.team = team
            self.stateMappings = stateMappings; self.labels = labels
        }

        /// What `load` puts in the form for this project.
        init(_ project: Project) {
            let tracking = project.tracking
            self.init(name: project.name, model: project.model ?? "", privateClones: project.usesPrivateClones,
                      requirePullRequest: project.effectiveRequirePullRequest,
                      channels: tracking?.slackChannels ?? [],
                      mentionOnlyChannels: Set(tracking?.slackMentionOnlyChannels ?? []),
                      groupHandles: (tracking?.slackGroupHandles ?? []).joined(separator: ", "),
                      team: tracking?.linearTeam.flatMap { $0.isEmpty ? nil : $0 },
                      stateMappings: tracking?.linearStateMappings ?? [:],
                      labels: (tracking?.slackLabels ?? []).filter { !$0.name.isEmpty })
        }
    }

    private var fields: Fields {
        Fields(name: name, model: model, privateClones: privateClones, requirePullRequest: requirePullRequest,
               channels: slackChannels.map(\.id), mentionOnlyChannels: slackMentionOnlyChannels,
               groupHandles: slackGroupHandles, team: linearTeam?.id, stateMappings: linearStateMappings, labels: savedLabels)
    }

    /// Labels as saved. Unnamed labels are drafts and are left out.
    private var savedLabels: [SlackProjectLabel] {
        slackLabels.map(\.label).filter { !$0.name.isEmpty }
    }

    var hasChanges: Bool { loaded != nil && loaded != fields }

    /// The server's project differs from the one the form was loaded from while the form has unsaved edits.
    var hasIncomingChanges: Bool {
        guard hasChanges, let latest, let loaded else { return false }
        return setAsideResponse || Fields(latest) != loaded
    }

    /// Takes an updated project value. A clean form follows it. A form with unsaved edits keeps them and only
    /// remembers the update, so Revert can load it and the save bar can say it arrived.
    func refresh(_ project: Project) {
        guard loaded != nil, latest?.id == project.id else { return load(project) }
        latest = project
        if isSaving { observedDuringSave = project }
        if !hasChanges || fields == Fields(project) { load(project) }
    }

    /// Drops unsaved edits and loads the latest server value.
    func revert() {
        guard !isSaving, let latest else { return }
        load(latest)
    }

    /// Sends the form as it is now. Edits made while the request is in flight stay unsaved, and a failure keeps every field.
    /// If a different project value arrived meanwhile, the response may be older or newer than it. Nothing is
    /// overwritten: the form keeps its fields, the arrived value becomes the baseline, and the bar says it was updated
    /// elsewhere, so Revert loads it and Save sends the form again.
    func save(_ send: (ProjectRequest) async throws -> Project) async {
        guard !isSaving, hasChanges else { return }
        let submitted = fields, token = generation
        isSaving = true
        observedDuringSave = nil
        defer { isSaving = false; observedDuringSave = nil }
        do {
            let saved = try await send(request)
            guard token == generation else { return }
            error = nil
            if let observed = observedDuringSave, Fields(observed) != Fields(saved) {
                latest = observed
                loaded = Fields(observed)
                setAsideResponse = true
                return
            }
            latest = saved
            if fields == submitted {
                load(saved)
            } else {
                loaded = Fields(saved)
            }
        } catch {
            guard token == generation else { return }
            self.error = error.localizedDescription
        }
    }

    func load(_ project: Project) {
        setAsideResponse = false
        if latest?.id != project.id { generation += 1 }
        latest = project
        name = project.name
        model = project.model ?? ""
        privateClones = project.usesPrivateClones
        requirePullRequest = project.effectiveRequirePullRequest
        let tracking = project.tracking
        slackLabels = (tracking?.slackLabels ?? []).map(EditableSlackLabel.init)
        slackChannels = (tracking?.slackChannels ?? []).map { TrackedChannelRef(id: $0, name: tracking?.slackChannelNames?[$0]) }
        slackMentionOnlyChannels = Set(tracking?.slackMentionOnlyChannels ?? [])
        slackGroupHandles = (tracking?.slackGroupHandles ?? []).joined(separator: ", ")
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
        slackMentionOnlyChannels.remove(id)
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
        let groups = slackGroupHandles.split { $0 == "," || $0.isWhitespace }.map(String.init)
        let mentionOnly = slackChannels.map(\.id).filter { slackMentionOnlyChannels.contains($0) }
        return ProjectRequest(
            name: name, model: model, workspace: privateClones ? "clone" : "direct",
            requirePullRequest: requirePullRequest,
            tracking: ProjectTrackingConfig(
                slackChannels: slackChannels.map(\.id),
                slackChannelNames: names.isEmpty ? nil : names,
                linearTeam: linearTeam?.id ?? "",
                linearTeamName: linearTeam?.name,
                slackLabels: labels.isEmpty ? nil : labels,
                linearStateMappings: linearTeam == nil || linearStateMappings.isEmpty ? nil : linearStateMappings,
                slackMentionOnlyChannels: mentionOnly.isEmpty ? nil : mentionOnly,
                slackGroupHandles: groups.isEmpty ? nil : groups
            )
        )
    }
}

/// One project's settings. Edits stay local until Save, whose bar appears only while something changed. Remove, at
/// the end of the page, keeps the chats and the folder.
private struct ProjectSettings: View {
    @Environment(\.hostViewContext) private var hostContext
    let project: Project
    @EndpointClient private var client
    @StateObject private var editor = ProjectEditor()
    @StateObject private var environment = EnvironmentSettingsModel()
    @State private var environmentSaving = false
    @State private var environmentError: String?
    @State private var confirmingRemoval = false
    @State private var removeError: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        SettingsPage(project.name, subtitle: project.path.abbreviatingHome) {
            if hostContext == nil || hostContext?.host.hostId == "local" {
                Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(filePath: project.path)]) }
                    .controlSize(.small)
            }
        } content: {
            SettingsSection("General") {
                SettingsRow("Name") {
                    TextField("Name", text: $editor.name)
                        .labelsHidden()
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 240)
                }
                SettingsRow("Default model") {
                    TextField("Default model", text: $editor.model, prompt: Text("pi default"))
                        .labelsHidden()
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 240)
                }
            }
            SettingsSection("Workspace") {
                SettingsToggle("Isolated workspace per chat",
                               detail: "Chats get their own working copy, so they never touch your checkout. Turn off to run in the folder itself.",
                               isOn: $editor.privateClones)
                SettingsToggle("Require a pull request",
                               detail: "Publish changes through a pull request. Turning this off allows direct pushes to the default branch. Applies when a chat next starts working.",
                               isOn: $editor.requirePullRequest)
            }
            EnvironmentSettingsSection(model: environment, hostName: hostName, check: {
                Task { await environment.check(client: client, cacheKey: environmentKey) }
            }, loadCatalog: {
                Task { await environment.loadCatalog(client: client) }
            })
            TrackingSettingsSection(project: project, editor: editor)
            if let host = hostContext?.host ?? AppModel.shared.localHost {
                ProjectDatabaseSettingsSection(projectId: project.id, host: host,
                                               hosts: hostContext?.hosts ?? AppModel.shared.hosts)
                    .id(HostResourceRef(host: host, kind: .project, localId: project.id).storageKey)
            }
            ProjectRemoval(error: removeError) { confirmingRemoval = true }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if editor.hasChanges || environment.hasChanges {
                SettingsSaveBar(error: editor.error ?? environmentError, updatedElsewhere: editor.hasIncomingChanges,
                                saving: editor.isSaving || environmentSaving,
                                revert: {
                                    editor.revert()
                                    environment.revert()
                                    environmentError = nil
                                }, save: { Task { await save() } })
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(Theme.Motion.standard(reduceMotion: reduceMotion), value: editor.hasChanges || environment.hasChanges)
        .onAppear { editor.load(project) }
        .onChange(of: project) { _, updated in
            editor.refresh(updated)
            Task { await environment.projectChanged(updated, client: client, cacheKey: environmentKey) }
        }
        .task(id: project.id) { await environment.load(project: project, client: client, cacheKey: environmentKey) }
        .confirmationDialog("Remove \(project.name)?", isPresented: $confirmingRemoval) {
            Button("Remove Project", role: .destructive) { Task { await remove() } }
        } message: {
            Text("Its chats are kept and the folder on disk is not changed.")
        }
    }

    private func save() async {
        let id = project.id
        if editor.hasChanges { await editor.save { try await client.updateProject(id, $0) } }
        guard editor.error == nil, environment.hasChanges, !environmentSaving else { return }
        environmentSaving = true
        defer { environmentSaving = false }
        do {
            try await environment.save(client: client)
            environmentError = nil
        } catch {
            environmentError = error.localizedDescription
        }
    }

    private var environmentKey: String {
        EnvironmentSettingsModel.cacheKey(host: hostContext?.host ?? AppModel.shared.localHost, projectId: project.id)
    }

    /// "this Mac" or the devbox's saved name, for the Environment section's plan heading.
    private var hostName: String {
        guard let host = hostContext?.host, host.hostId != "local" else { return "this Mac" }
        return AppModel.shared.hosts.offlineHosts[host]?.configuration.alias ?? "the devbox"
    }

    private func remove() async {
        do {
            try await client.deleteProject(project.id)
            removeError = nil
        } catch {
            removeError = error.localizedDescription
        }
    }
}

/// Pinned below a project page while it has unsaved edits: a save error or an update from elsewhere if any, then
/// Revert and Save. Revert loads the latest saved values.
struct SettingsSaveBar: View {
    let error: String?
    var updatedElsewhere = false
    let saving: Bool
    let revert: () -> Void
    let save: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HairlineDivider()
            HStack(spacing: 12) {
                if let error {
                    InlineProblem(error)
                        .lineLimit(2)
                        .help(error)
                } else if updatedElsewhere {
                    Text("Updated elsewhere. Revert loads it; Save replaces it.")
                        .font(.pilot(.label))
                        .foregroundStyle(Theme.mutedForeground)
                        .lineLimit(2)
                } else {
                    Text("Unsaved changes")
                        .font(.pilot(.label))
                        .foregroundStyle(Theme.mutedForeground)
                }
                Spacer(minLength: 8)
                if saving { ProgressView().controlSize(.small) }
                Button("Revert", action: revert)
                    .disabled(saving)
                Button("Save", action: save)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(saving)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 10)
            .frame(maxWidth: Theme.settingsColumn)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.background)
    }
}

/// The end of a project page: one line saying what removing does and a red outline button that asks to confirm.
private struct ProjectRemoval: View {
    let error: String?
    let remove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 16) {
                Text("\(Text("Remove project").foregroundStyle(Theme.foreground)) · Pilot forgets this project and its settings. Files on disk stay.")
                    .foregroundStyle(Theme.mutedForeground)
                    .font(.pilot(.label))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button("Remove Project…", action: remove)
                    .destructiveOutlineButtonStyle()
            }
            if let error {
                InlineProblem(error)
            }
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
