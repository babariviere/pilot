import Foundation
import PilotCore
import SwiftUI

// Project settings → Environment: what the repository declares (with citations), the confirmed profile, and the
// project's host's install plan preview. Shown only when the host advertises environmentSetup. Nothing here installs
// or runs anything; see docs/environment-setup.md.

/// The last plan each host returned, for display while it is offline. Titles and states only: no commands, paths or
/// output. Bounded, in Application Support.
@MainActor
final class EnvironmentLastKnownStore {
    static let shared = EnvironmentLastKnownStore()
    static let limit = 256

    private let file: URL
    private var entries: [String: EnvironmentLastKnown]?

    init(file: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Pilot/Environment/last-known.json")) {
        self.file = file
    }

    func value(_ key: String) -> EnvironmentLastKnown? { load()[key] }

    func save(_ value: EnvironmentLastKnown, for key: String) {
        var entries = load()
        entries[key] = value
        if entries.count > Self.limit {
            for stale in entries.sorted(by: { $0.value.checkedAt < $1.value.checkedAt }).prefix(entries.count - Self.limit) {
                entries.removeValue(forKey: stale.key)
            }
        }
        self.entries = entries
        let file = file
        Task.detached(priority: .utility) {
            guard let data = try? JSONEncoder().encode(entries) else { return }
            try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: file, options: .atomic)
        }
    }

    private func load() -> [String: EnvironmentLastKnown] {
        if let entries { return entries }
        let loaded = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode([String: EnvironmentLastKnown].self, from: $0) } ?? [:]
        entries = loaded
        return loaded
    }
}

@MainActor
final class EnvironmentSettingsModel: ObservableObject {
    enum Availability: Equatable {
        /// Asking the host whether it supports environment setup.
        case checking
        case available
        /// The host has no environmentSetup capability (or the feature is off). The section is hidden.
        case unavailable
        /// The host could not be reached; the last known plan is shown with actions disabled.
        case offline
    }

    @Published private(set) var availability: Availability = .checking
    @Published private(set) var discovery: EnvironmentDiscovery?
    @Published private(set) var plan: EnvironmentPlan?
    @Published private(set) var lastKnown: EnvironmentLastKnown?
    @Published var draft = EnvironmentDraft(saved: nil, discovery: nil)
    @Published private(set) var checking = false
    @Published private(set) var problem: String?
    /// Tool names from the host's mise registry. Nil until read; tools can always be entered by name.
    @Published private(set) var catalog: EnvironmentToolCatalog?
    private var loadingCatalog = false
    private var project: Project?
    private let store: EnvironmentLastKnownStore

    /// This host has an override layer; the plan already includes it. Editing overrides comes with profile sync.
    var hasHostOverride: Bool {
        guard let override = project?.environmentOverride else { return false }
        return override != ProjectEnvironmentOverride(revision: override.revision)
    }

    init(store: EnvironmentLastKnownStore? = nil) {
        self.store = store ?? .shared
    }

    var hasChanges: Bool { availability == .available && draft.hasChanges }

    static func cacheKey(host: HostRef?, projectId: String) -> String {
        host.map { "\($0.daemonId):\($0.lineageId):\(projectId)" } ?? "local:\(projectId)"
    }

    func load(project: Project, client: PilotClient, cacheKey: String) async {
        self.project = project
        lastKnown = store.value(cacheKey)
        draft = EnvironmentDraft(saved: project.environment, discovery: discovery)
        do {
            guard try await client.hello().capabilities.supportsEnvironmentSetup else {
                availability = .unavailable
                return
            }
        } catch {
            availability = lastKnown == nil ? .unavailable : .offline
            return
        }
        availability = .available
        await check(client: client, cacheKey: cacheKey)
    }

    /// Read the host's mise registry once per page, when the user starts adding a tool.
    func loadCatalog(client: PilotClient) async {
        guard catalog == nil, !loadingCatalog, availability == .available else { return }
        loadingCatalog = true
        defer { loadingCatalog = false }
        catalog = try? await client.environmentTools()
    }

    /// Read the repository again and recompute the plan. Both are read-only on the host.
    func check(client: PilotClient, cacheKey: String) async {
        guard let project, availability == .available, !checking else { return }
        checking = true
        defer { checking = false }
        var problems: [String] = []
        // Discovery is a quick bounded read; the plan probes the host and can take a few seconds.
        do {
            let value = try await client.environmentDiscovery(project.id)
            let editing = draft.hasChanges
            discovery = value
            if !editing { draft = EnvironmentDraft(saved: self.project?.environment, discovery: value) }
        } catch {
            problems.append("Couldn't read the repository: \(error.localizedDescription)")
        }
        do {
            let value = try await client.environmentPlan(project.id)
            plan = value
            let known = EnvironmentLastKnown(plan: value)
            lastKnown = known
            store.save(known, for: cacheKey)
        } catch {
            problems.append("Couldn't check the host: \(error.localizedDescription)")
        }
        problem = problems.isEmpty ? nil : problems.joined(separator: " ")
    }

    /// A saved profile arrived (this app or another client). Rebuild the draft and recheck when it changed.
    func projectChanged(_ updated: Project, client: PilotClient, cacheKey: String) async {
        let previous = project?.environment
        project = updated
        guard availability == .available, previous != updated.environment else { return }
        draft = EnvironmentDraft(saved: updated.environment, discovery: discovery)
        if previous?.revision != updated.environment?.revision {
            await check(client: client, cacheKey: cacheKey)
        }
    }

    func revert() {
        draft = EnvironmentDraft(saved: project?.environment, discovery: discovery)
    }

    func save(client: PilotClient) async throws {
        guard hasChanges, let project else { return }
        let request = ProjectEnvironmentUpdateRequest(environment: draft.profile,
                                                      expectedRevision: project.environment?.revision ?? 0)
        do {
            _ = try await client.updateEnvironment(project.id, request)
        } catch let error as ClientError where error.status == 409 {
            throw ClientError("The environment changed elsewhere. Review the latest version, then save again.", status: 409)
        }
    }
}

struct EnvironmentSettingsSection: View {
    @ObservedObject var model: EnvironmentSettingsModel
    let hostName: String
    let check: () -> Void
    let loadCatalog: () -> Void

    var body: some View {
        if model.availability == .available || model.availability == .offline {
            SettingsSection("Environment", explanation: "Toolchains from mise, Pilot's built-in database and setup steps this project needs. Pilot reads the repository's files to suggest them and never runs them.") {
                let offline = model.availability == .offline
                Group {
                    if model.draft.hasSuggestions {
                        SettingsRow("Suggestions from the repository", detail: "Turn on what the repository declares. Conflicts and missing versions stay for you to decide.") {
                            Button("Use Suggestions") { model.draft.useSuggestions() }
                                .controlSize(.small)
                        }
                    }
                    SettingsSubheading("Tools", note: "Installed and run with mise, by their mise names.")
                    ForEach($model.draft.tools) { $row in
                        EnvironmentToolRow(row: $row)
                    }
                    EnvironmentAddToolRow(names: model.catalog?.tools ?? [], miseFound: model.catalog?.mise,
                                          load: loadCatalog) { name in model.draft.addTool(name) }
                    if !model.draft.mentioned.isEmpty {
                        SettingsRow { SettingsNote("Also mentioned: \(model.draft.mentioned.joined(separator: ", "))") }
                    }
                    if !model.draft.undecided.isEmpty {
                        SettingsRow { SettingsNote("Not saved until it has a version: \(model.draft.undecided.joined(separator: ", ")).") }
                    }
                    SettingsSubheading("Database", note: "Pilot's own Postgres server on this host, separate from your other databases.")
                    EnvironmentDatabaseRow(database: $model.draft.database)
                    if !model.draft.steps.isEmpty {
                        SettingsSubheading("Setup steps", note: "Run in new and restored workspaces once you review them.")
                        ForEach($model.draft.steps) { $step in
                            SettingsToggle(step.title, detail: step.detail, isOn: $step.enabled)
                        }
                    }
                    SettingsSubheading("Local files", note: "Ignored files such as .env, copied from the main checkout into each new or restored workspace. Pilot never reads, stores or syncs their contents.")
                    EnvironmentLocalFiles(draft: $model.draft)
                    if model.hasHostOverride {
                        SettingsRow { SettingsNote("This host has its own overrides on top of these settings. The plan below includes them.") }
                    }
                }
                .disabled(offline)
                EnvironmentPlanSection(model: model, hostName: hostName, check: check)
            }
        }
    }
}

/// Adds a tool by its mise name. Suggestions come from the host's mise registry, read when the field is first used.
/// Local files to copy: one row per path with Remove, discovery's suggestions, and a field for any other path.
private struct EnvironmentLocalFiles: View {
    @Binding var draft: EnvironmentDraft
    @State private var path = ""
    @State private var invalid = false

    var body: some View {
        ForEach(draft.copyFiles, id: \.self) { file in
            SettingsRow(label: {
                Text(file).font(.pilot(.body, design: .monospaced)).foregroundStyle(Theme.foreground)
            }, control: {
                Button { draft.copyFiles.removeAll { $0 == file } } label: { PilotSymbol(PilotIcon.remove) }
                    .rowIconButtonStyle(hoverTint: Theme.destructive)
                    .help("Stop copying \(file)")
                    .accessibilityLabel("Stop copying \(file)")
            })
        }
        if !draft.localFileSuggestions.isEmpty {
            SettingsRow("Found in the main checkout", detail: "Ignored by Git, listed by name only.") {
                HStack(spacing: 6) {
                    ForEach(draft.localFileSuggestions, id: \.self) { file in
                        Button("Copy \(file)") { draft.addCopyFile(file) }
                            .controlSize(.small)
                    }
                }
            }
        }
        SettingsRow("Add a file", detail: invalid ? "Use a path inside the checkout, outside .git and .jj." : "A path relative to the checkout root.") {
            HStack(spacing: 8) {
                TextField("File", text: $path, prompt: Text(".env.local"))
                    .labelsHidden()
                    .textFieldStyle(.roundedBorder)
                    .font(.pilot(.label, design: .monospaced))
                    .frame(width: 180)
                    .onChange(of: path) { _, _ in invalid = false }
                    .onSubmit(add)
                Button("Add", action: add)
                    .controlSize(.small)
                    .disabled(path.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    private func add() {
        if draft.addCopyFile(path) { path = "" } else { invalid = true }
    }
}

private struct EnvironmentAddToolRow: View {
    let names: [String]
    let miseFound: Bool?
    let load: () -> Void
    let add: (String) -> Bool
    @State private var query = ""
    @State private var invalid = false

    private var matches: [String] { EnvironmentNames.matches(query, in: names) }

    private var detail: String {
        if invalid { return "Use a mise registry name, or a backend such as aqua:owner/repo." }
        if miseFound == false { return "mise isn't installed on this host yet; enter the tool's mise name." }
        return "Search mise's registry, or enter a backend such as aqua:owner/repo."
    }

    var body: some View {
        SettingsRow("Add a tool", detail: detail) {
            HStack(spacing: 8) {
                TextField("Tool", text: $query, prompt: Text("terraform"))
                    .labelsHidden()
                    .textFieldStyle(.roundedBorder)
                    .font(.pilot(.label, design: .monospaced))
                    .frame(width: 180)
                    .onChange(of: query) { _, _ in
                        invalid = false
                        load()
                    }
                    .onSubmit(submit)
                Button("Add", action: submit)
                    .controlSize(.small)
                    .disabled(query.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        if !matches.isEmpty, !names.contains(query) {
            SettingsRow {
                HStack(spacing: 6) {
                    ForEach(matches, id: \.self) { name in
                        Button(name) {
                            query = name
                            submit()
                        }
                        .controlSize(.small)
                    }
                }
            }
        }
    }

    private func submit() {
        let name = query.trimmingCharacters(in: .whitespaces)
        let known = names.isEmpty || name.contains(":") || names.contains(name)
        guard known, add(name) else {
            invalid = true
            return
        }
        query = ""
    }
}

private struct EnvironmentToolRow: View {
    @Binding var row: EnvironmentDraft.ToolRow

    var body: some View {
        SettingsRow(row.title, detail: row.detail) {
            HStack(spacing: 8) {
                if row.options.count > 1 {
                    Menu("Pick") {
                        ForEach(row.options, id: \.self) { option in
                            Button("\(option.value) · \(option.citation)") { row.choose(option.value) }
                        }
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    .controlSize(.small)
                }
                TextField("Version", text: Binding(get: { row.version }, set: { row.choose($0) }))
                    .labelsHidden()
                    .textFieldStyle(.roundedBorder)
                    .font(.pilot(.label, design: .monospaced))
                    .frame(width: 96)
                Toggle(row.title, isOn: $row.included)
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .controlSize(.small)
                    .accessibilityLabel("Include \(row.title)")
            }
        }
    }
}

private struct EnvironmentDatabaseRow: View {
    @Binding var database: EnvironmentDraft.Database

    var body: some View {
        SettingsRow("Built-in Postgres", detail: database.detail) {
            HStack(spacing: 8) {
                Picker("Postgres version", selection: $database.version) {
                    ForEach(database.options, id: \.self) { Text("Postgres \($0)").tag($0) }
                }
                .labelsHidden()
                .fixedSize()
                Toggle("Built-in database", isOn: $database.enabled)
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .controlSize(.small)
                    .accessibilityLabel("Use Pilot's built-in Postgres")
            }
        }
    }
}

/// The host's plan: live lines with paths and commands, or the last known titles and states while offline.
private struct EnvironmentPlanSection: View {
    @ObservedObject var model: EnvironmentSettingsModel
    let hostName: String
    let check: () -> Void

    private var lines: [EnvironmentPlanLine] {
        if model.availability == .available, let plan = model.plan {
            return plan.items.map { EnvironmentPlanLine($0, home: NSHomeDirectory()) }
        }
        return model.lastKnown?.lines ?? []
    }

    private var note: String {
        if model.availability == .offline {
            let when = model.lastKnown.map { "Last known · \(RelativeDate.ago($0.checkedAt))" } ?? "Not checked yet"
            return "\(when) · \(hostName) disconnected"
        }
        guard let plan = model.plan else { return model.checking ? "Checking…" : "Not checked yet" }
        let incomplete = plan.incomplete == true ? " · some locations were not checked" : ""
        return "Checked \(RelativeDate.ago(plan.computedAt))\(incomplete) · preview only, nothing is installed yet"
    }

    var body: some View {
        SettingsSubheading("On \(hostName)", note: note) {
            HStack(spacing: 6) {
                if model.checking { ProgressView().controlSize(.small) }
                Button("Check Again", action: check)
                    .controlSize(.small)
                    .disabled(model.availability != .available || model.checking)
            }
        }
        if let problem = model.problem, model.availability == .available {
            SettingsRow { InlineProblem(problem, retrying: model.checking, retry: check) }
        }
        if lines.isEmpty, model.plan != nil {
            SettingsRow { SettingsNote("Save the tools, database or setup steps this project needs to see what this host is missing.") }
        }
        ForEach(lines) { line in
            EnvironmentPlanRow(line: line)
        }
        .opacity(model.availability == .offline ? 0.6 : 1)
    }
}

private struct EnvironmentPlanRow: View {
    let line: EnvironmentPlanLine

    var body: some View {
        SettingsRow {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(line.title)
                        .font(.pilot(.body))
                        .foregroundStyle(Theme.foreground)
                        .lineLimit(1)
                        .frame(width: 180, alignment: .leading)
                    Text(line.state)
                        .font(.pilot(.caption))
                        .foregroundStyle(line.attention ? Theme.blocked : Theme.mutedForeground)
                        .frame(width: 92, alignment: .leading)
                    if let detail = line.detail {
                        Text(detail)
                            .font(.pilot(.caption))
                            .foregroundStyle(Theme.mutedForeground)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .help(detail)
                    }
                }
                ForEach(line.commands ?? [], id: \.self) { command in
                    Text(command)
                        .font(.pilot(.caption, design: .monospaced))
                        .foregroundStyle(Theme.foreground)
                        .textSelection(.enabled)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(RoundedRectangle(cornerRadius: Theme.Radius.small).fill(Theme.muted))
                        .padding(.leading, 192)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }
}
