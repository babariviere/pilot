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

    init() {
        chatFontFamily = defaults.string(forKey: "chatFontFamily") ?? Self.systemFont
        chatFontSize = defaults.object(forKey: "chatFontSize") as? Double ?? 14
        codeFontFamily = defaults.string(forKey: "codeFontFamily") ?? Self.systemMono
        codeFontSize = defaults.object(forKey: "codeFontSize") as? Double ?? 12
        terminalFontFamily = defaults.string(forKey: "terminalFontFamily") ?? ""
        terminalFontSize = defaults.object(forKey: "terminalFontSize") as? Double ?? 0
        useGhosttyConfig = defaults.object(forKey: "useGhosttyConfig") as? Bool ?? true
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

    func nsChat(_ size: Double) -> NSFont {
        guard chatFamily != AppSettings.systemFont,
              let font = NSFontManager.shared.font(withFamily: chatFamily, traits: [], weight: 5, size: size)
        else { return .systemFont(ofSize: size) }
        return font
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

struct SettingsView: View {
    var body: some View {
        TabView {
            AppearanceSettings()
                .tabItem { Label("Appearance", systemImage: "textformat") }
            TerminalSettings()
                .tabItem { Label("Terminal", systemImage: "terminal") }
            ProjectSettings()
                .tabItem { Label("Projects", systemImage: "folder") }
            UpdateSettings()
                .tabItem { Label("Updates", systemImage: "arrow.down.circle") }
        }
        .frame(width: 560, height: 420)
    }
}

private struct AppearanceSettings: View {
    @ObservedObject private var settings = AppSettings.shared

    var body: some View {
        Form {
            Section("Chat") {
                FontFamilyPicker(title: "Font", selection: $settings.chatFontFamily, system: AppSettings.systemFont, families: AppSettings.fontFamilies)
                SizeStepper(title: "Size", value: $settings.chatFontSize, range: 11 ... 22)
            }
            Section("Code and tool output") {
                FontFamilyPicker(title: "Font", selection: $settings.codeFontFamily, system: AppSettings.systemMono, families: AppSettings.monospacedFamilies)
                SizeStepper(title: "Size", value: $settings.codeFontSize, range: 9 ... 20)
            }
            Section("Preview") {
                VStack(alignment: .leading, spacing: 8) {
                    Text("The flaky test was a race in the session reopen path.").font(settings.fonts.body)
                    Text("npm test -- --grep reopen").font(settings.fonts.mono)
                }
                .padding(.vertical, 4)
            }
            HStack {
                Spacer()
                Button("Restore Defaults") { settings.resetFonts() }
            }
        }
        .formStyle(.grouped)
    }
}

private struct TerminalSettings: View {
    @ObservedObject private var settings = AppSettings.shared

    var body: some View {
        Form {
            Section {
                Toggle("Use ~/.config/ghostty/config", isOn: $settings.useGhosttyConfig)
                Text("Theme, keybindings and other Ghostty options come from your Ghostty config. The font settings below override it.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section("Font") {
                Picker("Family", selection: $settings.terminalFontFamily) {
                    Text("From Ghostty config").tag("")
                    Divider()
                    ForEach(AppSettings.monospacedFamilies, id: \.self) { Text($0).tag($0) }
                }
                HStack {
                    Toggle("Custom size", isOn: Binding(
                        get: { settings.terminalFontSize > 0 },
                        set: { settings.terminalFontSize = $0 ? 13 : 0 }
                    ))
                    if settings.terminalFontSize > 0 {
                        Spacer()
                        Stepper("\(Int(settings.terminalFontSize)) pt", value: $settings.terminalFontSize, in: 8 ... 28)
                    }
                }
            }
        }
        .formStyle(.grouped)
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

    var body: some View {
        Stepper(value: $value, in: range, step: 0.5) {
            HStack {
                Text(title)
                Spacer()
                Text("\(value, specifier: value.rounded() == value ? "%.0f" : "%.1f") pt").foregroundStyle(.secondary)
            }
        }
    }
}

@MainActor
final class ProjectEditor: ObservableObject {
    @Published var selection: String?
    @Published var name = ""
    @Published var model = ""
    @Published var privateClones = true
    @Published var error: String?
}

private struct ProjectSettings: View {
    @ObservedObject private var client = AppModel.shared.client
    @StateObject private var editor = ProjectEditor()

    var body: some View {
        HSplitView {
            VStack(spacing: 0) {
                List(selection: $editor.selection) {
                    ForEach(client.projects) { project in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(project.name)
                            Text(project.path.abbreviatingHome).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        .tag(project.id)
                    }
                }
                HStack(spacing: 0) {
                    Button { Task { await addProject() } } label: { Image(systemName: "plus").frame(width: 24, height: 20) }
                    Button { Task { await removeSelected() } } label: { Image(systemName: "minus").frame(width: 24, height: 20) }
                        .disabled(editor.selection == nil)
                    Spacer()
                }
                .buttonStyle(.borderless)
                .padding(6)
            }
            .frame(minWidth: 200, idealWidth: 220)

            Group {
                if let project = client.projects.first(where: { $0.id == editor.selection }) {
                    Form {
                        TextField("Name", text: $editor.name)
                        LabeledContent("Folder") { Text(project.path.abbreviatingHome).textSelection(.enabled) }
                        TextField("Default model", text: $editor.model, prompt: Text("pi default"))
                        Toggle("Run each session in a private clone", isOn: $editor.privateClones)
                        Text("Sessions get their own clone and pilot/… branch, so they never touch your checkout. Turn off to run in the folder itself.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if let error = editor.error { Text(error).foregroundStyle(.red) }
                        HStack {
                            Spacer()
                            Button("Save") { Task { await save(project) } }
                                .keyboardShortcut(.defaultAction)
                        }
                    }
                    .formStyle(.grouped)
                    .onAppear { load(project) }
                    .onChange(of: project) { _, updated in load(updated) }
                } else {
                    Text(client.projects.isEmpty ? "Add a project to group sessions by repository." : "Select a project")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(minWidth: 280)
        }
    }

    private func load(_ project: Project) {
        editor.name = project.name
        editor.model = project.model ?? ""
        editor.privateClones = project.usesPrivateClones
        editor.error = nil
    }

    private func save(_ project: Project) async {
        do {
            _ = try await client.updateProject(
                project.id,
                ProjectRequest(name: editor.name, model: editor.model, workspace: editor.privateClones ? "clone" : "direct")
            )
            editor.error = nil
        } catch {
            editor.error = error.localizedDescription
        }
    }

    private func addProject() async {
        guard let path = chooseFolder() else { return }
        do {
            editor.selection = try await client.createProject(ProjectRequest(path: path)).id
        } catch {
            editor.error = error.localizedDescription
        }
    }

    private func removeSelected() async {
        guard let id = editor.selection else { return }
        try? await client.deleteProject(id)
        editor.selection = nil
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
