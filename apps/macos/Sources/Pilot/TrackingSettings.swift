import AppKit
import PilotCore
import SwiftUI

// Project settings → Tracking: attach a Linear team, pick Slack channels and define the labels Slack messages
// are sorted into. Lookups are read-only MCP calls made by pilotd; nothing is tracked until the project is saved.

/// A configured Slack channel: its ID and, when picked from Slack, its name.
struct TrackedChannelRef: Hashable, Identifiable {
    let id: String
    var name: String?

    /// "#bugs". Older configs stored names instead of IDs.
    var display: String {
        let value = name ?? id
        return value.hasPrefix("#") ? value : "#\(value)"
    }
}

/// The attached Linear team.
struct TrackedTeamRef: Hashable {
    let id: String
    var name: String?
}

/// Recent picker lookups, so reopening settings does not start another MCP call. Successful results only.
@MainActor
private enum TrackingLookupCache {
    static var teams: (at: Date, value: TrackingLookup<LinearTeamOption>)?
    static var myChannels: (at: Date, value: TrackingLookup<SlackChannelOption>)?
    static let lifetime: TimeInterval = 600

    static func fresh<T>(_ entry: (at: Date, value: TrackingLookup<T>)?) -> TrackingLookup<T>? {
        guard let entry, Date().timeIntervalSince(entry.at) < lifetime else { return nil }
        return entry.value
    }
}

struct TrackingSettingsSection: View {
    let project: Project
    @ObservedObject var editor: ProjectEditor
    var channelQuery = ""
    @ObservedObject private var client = AppModel.shared.client

    var body: some View {
        SettingsSection("Linear and Slack", explanation: "Pilot reads Linear and Slack through your pi MCP servers. Confirming Start chat or Start mission applies the In progress mapping, or adds an eyes reaction on Slack. The other Linear mappings are saved only. Pilot never posts messages or comments, and never starts work on its own.") {
            LinearTeamPicker(selection: $editor.linearTeam,
                             stateMappings: $editor.linearStateMappings,
                             source: client.source(projectId: project.id, kind: .linear),
                             saved: project.tracking?.linearTeam)
            SlackChannelsEditor(editor: editor,
                                source: client.source(projectId: project.id, kind: .slack),
                                saved: Set(project.tracking?.slackChannels ?? []), query: channelQuery)
        }
        if !editor.slackChannels.isEmpty || !editor.slackLabels.isEmpty {
            SlackLabelsSection(project: project, editor: editor)
        }
    }
}

/// Linear team picker from list_teams. Attaching a team shows my issues in it (and its sub-teams) and its
/// current cycle on the project page.
struct LinearTeamPicker: View {
    @Binding var selection: TrackedTeamRef?
    @Binding var stateMappings: [String: LinearStateMapping]
    let source: TrackingSource?
    let saved: String?
    @ObservedObject private var client = AppModel.shared.client
    @ObservedObject private var signIns = AppModel.shared.client.sourceSignIns
    @State private var lookup: TrackingLookup<LinearTeamOption>?
    @State private var loading = false

    private var teams: [LinearTeamOption] { lookup?.items ?? [] }

    var body: some View {
        SettingsRow {
            VStack(alignment: .leading, spacing: 2) {
                Text("Linear team").font(.pilot(.body)).foregroundStyle(Theme.foreground)
                Text(detail).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } control: {
            HStack(spacing: 6) {
                if loading { ProgressView().controlSize(.small) }
                Picker("Linear team", selection: binding) {
                    Text("None").tag("")
                    if let selection, !teams.contains(where: { $0.id == selection.id }) {
                        Text(selection.name ?? selection.id).tag(selection.id)
                    }
                    if !teams.isEmpty { Divider() }
                    ForEach(ordered, id: \.team.id) { entry in
                        Text(entry.label).tag(entry.team.id)
                    }
                }
                .labelsHidden()
                .fixedSize()
            }
        }
        .task { await load(force: false) }
        .onChange(of: signIns[.linear]?.state) { _, state in
            if state == .done { Task { await load(force: true) } }
        }
        if let lookup, lookup.status == .error {
            SettingsRow {
                TrackingLookupProblem(service: "Linear", lookup: lookup) { Task { await load(force: true) } }
            }
        }
        SourceAccountRow(kind: .linear, label: "Linear",
                         needsSignIn: lookup?.status == .signInRequired || source?.status == .signInRequired,
                         connected: lookup?.status == .ok || source?.status == .ok || source?.status == .syncing,
                         purpose: "Sign in to pick a team and read your issues.")
        if let selection, lookup?.status == .ok, !loading {
            LinearStateMappingSettings(root: selection, teams: teams, selections: $stateMappings)
        }
    }

    private var binding: Binding<String> {
        Binding(get: { selection?.id ?? "" }, set: { id in
            if id != selection?.id { stateMappings = [:] }
            selection = id.isEmpty ? nil
                : TrackedTeamRef(id: id, name: teams.first { $0.id == id }?.name ?? selection?.name)
        })
    }

    private var detail: String {
        guard let selection else { return "Attach a team to follow your issues in it, including its sub-teams." }
        guard selection.id == saved, let source, source.configured else { return "Save to start syncing." }
        // The account row below says what to do.
        if source.status == .signInRequired { return "Your issues and its current cycle." }
        let line = TrackedItemText.sourceLine(source, signIn: signIns[.linear])
        return line.tone == .attention ? line.text : "Your issues and its current cycle · \(line.text)"
    }

    /// Sub-teams read "Parent › Team", sorted with their parent.
    private var ordered: [(team: LinearTeamOption, label: String)] {
        let byId = Dictionary(teams.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return teams.map { team in
            let parent = team.parentId.flatMap { byId[$0]?.name }
            return (team, [parent, team.name].compactMap { $0 }.joined(separator: " › "))
        }
        .sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
    }

    private func load(force: Bool) async {
        if !force, let cached = TrackingLookupCache.fresh(TrackingLookupCache.teams) {
            lookup = cached
            return
        }
        loading = true
        defer { loading = false }
        do {
            let result = try await client.linearTeams()
            lookup = result
            if result.status == .ok { TrackingLookupCache.teams = (Date(), result) }
        } catch {
            lookup = TrackingLookup(status: .error, error: error.localizedDescription)
        }
    }
}

/// Configured Slack channels with their status and a remove button, then a search field that adds more.
/// Suggestions come from the channels I'm in; typing searches public and private channels I can read.
struct SlackChannelsEditor: View {
    @ObservedObject var editor: ProjectEditor
    let source: TrackingSource?
    let saved: Set<String>
    @ObservedObject private var client = AppModel.shared.client
    @ObservedObject private var signIns = AppModel.shared.client.sourceSignIns
    @State private var query = ""
    @State private var mine: TrackingLookup<SlackChannelOption>?
    @State private var results: TrackingLookup<SlackChannelOption>?
    @State private var searching = false
    @FocusState private var focused: Bool

    /// The query starts empty in the app; snapshots pass one to show matches.
    init(editor: ProjectEditor, source: TrackingSource?, saved: Set<String>, query: String = "") {
        self.editor = editor
        self.source = source
        self.saved = saved
        _query = State(initialValue: query)
    }

    var body: some View {
        SettingsRow {
            SettingsRowLabel(title: "Slack channels",
                             detail: editor.slackChannels.isEmpty ? "Add the channels to follow. New messages are sorted into bugs, questions and requests by a small model."
                                 : "Each channel is read from the moment you add it, with a short look back.")
        }
        ForEach(editor.slackChannels) { channel in
            SettingsRow {
                SlackChannelRow(channel: channel, status: source?.channels?.first { $0.id == channel.id },
                                saved: saved.contains(channel.id)) { editor.removeChannel(channel.id) }
            }
        }
        SettingsRow {
            HStack(spacing: 6) {
                PilotSymbol(PilotIcon.search).foregroundStyle(Theme.mutedForeground).accessibilityHidden(true)
                TextField("Add channel", text: $query, prompt: Text("Search channels to add"))
                    .textFieldStyle(.plain)
                    .labelsHidden()
                    .focused($focused)
                    .onSubmit { if let first = candidates.first { add(first) } }
                if searching { ProgressView().controlSize(.small) }
            }
        }
        if focused || !query.isEmpty {
            SettingsRow { suggestions }
        }
        SourceAccountRow(kind: .slack, label: "Slack",
                         needsSignIn: mine?.status == .signInRequired || results?.status == .signInRequired
                             || source?.status == .signInRequired,
                         connected: mine?.status == .ok || results?.status == .ok || source?.status == .ok
                             || source?.status == .syncing,
                         purpose: "Sign in to find channels and read their messages.")
            .onChange(of: signIns[.slack]?.state) { _, state in
                guard state == .done else { return }
                Task {
                    await loadMine(force: true)
                    await search()
                }
            }
    }

    private var suggestions: some View {
        let lookup = query.isEmpty ? mine : results
        return VStack(alignment: .leading, spacing: 2) {
            Text(query.isEmpty ? "Channels you're in" : "Matching channels").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            ForEach(candidates.prefix(6)) { option in
                HStack(spacing: 6) {
                    PilotSymbol(option.isPrivate ? PilotIcon.privateChannel : PilotIcon.slackChannel).foregroundStyle(Theme.mutedForeground)
                        .frame(width: 14)
                        .accessibilityLabel(option.isPrivate ? "Private channel" : "Channel")
                    Text(option.name).lineLimit(1)
                    Spacer(minLength: 8)
                    Button("Add") { add(option) }.controlSize(.small)
                }
                .padding(.vertical, 2)
            }
            if let lookup, lookup.status == .signInRequired {
                Text("Sign in to Slack below to search channels.").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            } else if let lookup, lookup.status != .ok {
                TrackingLookupProblem(service: "Slack", lookup: lookup) { retry() }
            } else if candidates.isEmpty, !searching, lookup != nil {
                Text(query.isEmpty ? "No more channels to suggest. Search to find others." : "No channels match.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            } else if lookup?.more == true || candidates.count > 6 {
                Text("Refine the search to see more.").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            }
        }
        .task(id: query) { await search() }
        .task { await loadMine(force: false) }
    }

    /// My channels that match locally come first, then search results. Added channels are left out.
    private var candidates: [SlackChannelOption] {
        let added = Set(editor.slackChannels.map(\.id))
        let needle = query.trimmingCharacters(in: CharacterSet(charactersIn: "# ")).lowercased()
        let local = (mine?.items ?? []).filter { needle.isEmpty || $0.name.lowercased().contains(needle) }
        let remote = needle.isEmpty ? [] : results?.items ?? []
        var seen = added
        return (local + remote).filter { seen.insert($0.id).inserted }
    }

    private func add(_ option: SlackChannelOption) {
        editor.addChannel(option)
        query = ""
    }

    private func retry() {
        Task {
            if query.isEmpty { await loadMine(force: true) } else { await search() }
        }
    }

    private func loadMine(force: Bool) async {
        if !force, mine != nil { return }
        if !force, let cached = TrackingLookupCache.fresh(TrackingLookupCache.myChannels) {
            mine = cached
            return
        }
        do {
            let result = try await client.slackChannelOptions()
            mine = result
            if result.status == .ok { TrackingLookupCache.myChannels = (Date(), result) }
        } catch {
            mine = TrackingLookup(status: .error, error: error.localizedDescription)
        }
    }

    /// Debounced; the latest query wins here and in pilotd.
    private func search() async {
        let text = query.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else {
            results = nil
            return
        }
        try? await Task.sleep(for: .milliseconds(350))
        guard !Task.isCancelled else { return }
        searching = true
        defer { searching = false }
        do {
            let result = try await client.slackChannelOptions(query: text)
            if !Task.isCancelled { results = result }
        } catch {
            if !Task.isCancelled { results = TrackingLookup(status: .error, error: error.localizedDescription) }
        }
    }
}

/// One configured channel: name, per-channel status and remove.
private struct SlackChannelRow: View {
    let channel: TrackedChannelRef
    let status: SlackChannelStatus?
    let saved: Bool
    let remove: () -> Void

    var body: some View {
        let line = TrackedItemText.channelStatus(status, saved: saved)
        HStack(spacing: 8) {
            Text(channel.display).lineLimit(1)
            Spacer(minLength: 8)
            HStack(spacing: 4) {
                if line.tone == .attention {
                    PilotSymbol(PilotIcon.warning).accessibilityHidden(true)
                }
                Text(line.text)
            }
            .font(.pilot(.caption))
            .foregroundStyle(line.tone == .attention ? Theme.blocked : Theme.mutedForeground)
            .help(status?.error ?? (status?.status == .signInRequired ? "Sign in to Slack below." : line.text))
            Button(action: remove) { PilotSymbol(PilotIcon.remove) }
                .rowIconButtonStyle(hoverTint: Theme.destructive)
                .help("Stop reading \(channel.display)")
                .accessibilityLabel("Remove \(channel.display)")
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(channel.display), \(line.text)")
        .accessibilityAction(named: "Remove", remove)
    }
}

/// A failed lookup with a retry. Sign-in required is handled by the source's account row.
private struct TrackingLookupProblem<Item: Codable & Equatable & Sendable>: View {
    let service: String
    let lookup: TrackingLookup<Item>
    let retry: () -> Void

    var body: some View {
        InlineProblem(lookup.error ?? "Couldn't reach \(service).", retry: retry)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A label row in the settings editor. The id keeps rows stable while their name is edited.
struct EditableSlackLabel: Identifiable, Equatable {
    let id = UUID()
    var name: String
    var description: String
    var effect: SlackLabelEffect

    init(_ label: SlackProjectLabel) {
        name = label.name
        description = label.description
        effect = label.effect
    }

    /// The label as saved: one trimmed line each, within pilotd's limits.
    var label: SlackProjectLabel {
        SlackProjectLabel(name: Self.line(name, limit: 80), description: Self.line(description, limit: 240),
                          effect: effect)
    }

    private static func line(_ value: String, limit: Int) -> String {
        let flat = value.components(separatedBy: .controlCharacters).joined(separator: " ")
        return String(flat.trimmingCharacters(in: .whitespaces).prefix(limit))
    }
}

/// Labels Slack messages are sorted into, defined per project, then the latest corrections. The classifier
/// reads each label's name and description and picks at most one. Effects hide or close messages locally.
struct SlackLabelsSection: View {
    let project: Project
    @ObservedObject var editor: ProjectEditor

    var body: some View {
        let names = editor.slackLabels.map(\.label.name).filter { !$0.isEmpty }
        let duplicates = Set(names.filter { name in names.filter { $0 == name }.count > 1 })
        SettingsSection("Slack labels", explanation: "The classifier gives each message at most one label, using its description and your corrections in Slack triage.") {
            if editor.slackLabels.isEmpty {
                SettingsRow {
                    Text("No labels yet. Add one for each kind of message you sort, such as an owning team.")
                        .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                }
            }
            ForEach($editor.slackLabels) { $label in
                SlackLabelRow(label: $label, duplicate: duplicates.contains(label.label.name)) {
                    editor.removeLabel(label.id)
                }
            }
            SettingsRow {
                Button { editor.addLabel() } label: {
                    Label("Add label", icon: PilotIcon.add)
                        .font(.pilot(.label))
                        .contentShape(Rectangle())
                }
                .rowButtonStyle(outset: 2)
                .foregroundStyle(Theme.mutedForeground)
                .disabled(editor.slackLabels.count >= 50)
            }
            SlackCorrectionsList(projectId: project.id)
        }
    }
}

/// A label: its name and a description that wraps to two lines, the effect menu and a remove button revealed on
/// hover (and under keyboard focus, and as a VoiceOver action).
private struct SlackLabelRow: View {
    @Binding var label: EditableSlackLabel
    let duplicate: Bool
    let remove: () -> Void
    @State private var hovered = false

    var body: some View {
        SettingsRow {
            VStack(alignment: .leading, spacing: 3) {
                TextField("Name", text: $label.name, prompt: Text("Label name"))
                    .textFieldStyle(.plain).labelsHidden()
                    .font(.pilot(.body, weight: .medium))
                TextField("Description", text: $label.description,
                          prompt: Text("Which messages get this label, in one sentence"), axis: .vertical)
                    .textFieldStyle(.plain).labelsHidden()
                    .lineLimit(1 ... 2)
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                if duplicate {
                    Text("Another label has this name.").font(.pilot(.caption)).foregroundStyle(Theme.error)
                }
            }
        } control: {
            HStack(spacing: 6) {
                Menu {
                    Picker("Effect", selection: $label.effect) {
                        ForEach(SlackLabelEffect.allCases, id: \.self) { effect in
                            Text(effect.settingsTitle).tag(effect)
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                } label: {
                    Text("Effect: \(label.effect.settingsTitle)")
                }
                .menuStyle(.borderlessButton)
                .font(.pilot(.label))
                .foregroundStyle(Theme.mutedForeground)
                .fixedSize()
                .accessibilityLabel("Label effect, \(label.effect.settingsTitle)")
                .help("Hide keeps messages out of the Inbox. Close dismisses them unless you set a status. Both stay in Slack triage behind Show hidden.")
                Button(action: remove) { PilotSymbol(PilotIcon.remove) }
                    .rowIconButtonStyle(hoverTint: Theme.destructive)
                    .help("Remove this label")
                    .accessibilityLabel(label.name.isEmpty ? "Remove label" : "Remove \(label.name)")
                    .revealed(hovered)
            }
        }
        .contentShape(Rectangle())
        .onHover { hovered = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: label.name.isEmpty ? "Remove label" : "Remove \(label.name)", remove)
    }
}

extension SlackLabelEffect {
    /// The effect's name in the settings menu ("Effect: None").
    var settingsTitle: String {
        switch self {
        case .none: "None"
        case .hide: "Hide from Inbox"
        case .close: "Close"
        }
    }
}

/// The latest triage corrections, newest first, five at a time with "Show N more". Read-only; they change as the user
/// reclassifies messages.
private struct SlackCorrectionsList: View {
    let projectId: String
    @ObservedObject private var client = AppModel.shared.client
    @State private var corrections: [SlackCorrection]?
    @State private var failed = false
    @State private var expanded = false
    private static let shown = 5

    var body: some View {
        let items = corrections ?? []
        let visible = expanded ? items : Array(items.prefix(Self.shown))
        VStack(alignment: .leading, spacing: 3) {
            Text("Recent corrections").font(.pilot(.body, weight: .medium)).foregroundStyle(Theme.foreground)
                .accessibilityAddTraits(.isHeader)
            Text(failed ? "Couldn't load your corrections."
                : items.isEmpty ? "Changes you make in Slack triage appear here. The latest 20 teach the classifier."
                : "The latest 20 teach the classifier.")
                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 18)
        .padding(.bottom, 8)
        .task(id: projectId) { await load() }
        ForEach(Array(visible.enumerated()), id: \.offset) { _, correction in
            SettingsRow {
                Text(correction.summary).font(.pilot(.body)).foregroundStyle(Theme.foreground)
                    .lineLimit(1).truncationMode(.tail)
            } control: {
                Text(SlackTriageText.correction(correction.values)).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    .lineLimit(1).fixedSize()
            }
            .accessibilityElement(children: .combine)
        }
        if items.count > Self.shown {
            SettingsRow {
                Button { expanded.toggle() } label: {
                    Text(expanded ? "Show fewer" : "Show \(items.count - Self.shown) more")
                        .font(.pilot(.caption))
                        .foregroundStyle(Theme.mutedForeground)
                        .contentShape(Rectangle())
                }
                .rowButtonStyle(outset: 2)
            }
        }
    }

    private func load() async {
        do {
            corrections = try await client.slackCorrections(projectId: projectId)
            failed = false
        } catch {
            failed = true
        }
    }
}

/// The account a source reads with: Sign in when pilotd needs one, then "Waiting for sign-in in your
/// browser…" with Cancel, and Sign in again once connected (another account or new access).
private struct SourceAccountRow: View {
    let kind: TrackedKind
    let label: String
    let needsSignIn: Bool
    let connected: Bool
    /// Why to sign in, shown when sign-in is required.
    let purpose: String
    @ObservedObject private var signIns = AppModel.shared.client.sourceSignIns

    var body: some View {
        let state = TrackingAccountText.state(signIns[kind], needsSignIn: needsSignIn, connected: connected,
                                              purpose: purpose)
        SettingsRow {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(label) account").font(.pilot(.body)).foregroundStyle(Theme.foreground)
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    if state.attention {
                        PilotSymbol(PilotIcon.signInRequired).accessibilityHidden(true)
                    }
                    Text(state.text).fixedSize(horizontal: false, vertical: true)
                }
                .font(.pilot(.caption))
                .foregroundStyle(state.attention ? Theme.blocked : Theme.mutedForeground)
            }
        } control: {
            HStack(spacing: 6) {
                if state.waiting { ProgressView().controlSize(.small) }
                SourceSignInButton(kind: kind, label: label, again: !needsSignIn)
            }
        }
        .accessibilityElement(children: .contain)
    }
}

/// Wording of a source's account row, kept apart from the view for tests.
enum TrackingAccountText {
    struct State: Equatable {
        let text: String
        let attention: Bool
        let waiting: Bool
    }

    static func state(_ signIn: SourceSignIn?, needsSignIn: Bool, connected: Bool, purpose: String) -> State {
        if signIn?.state == .waiting {
            return State(text: TrackedItemText.signInWaiting, attention: false, waiting: true)
        }
        // A failed attempt matters while sign-in is still needed, or when signing in again failed.
        if let problem = TrackedItemText.signInProblem(signIn), needsSignIn || signIn?.again == true {
            return State(text: problem, attention: true, waiting: false)
        }
        if needsSignIn { return State(text: purpose, attention: true, waiting: false) }
        return State(text: connected ? "Signed in through pi" : "Uses your pi sign-in", attention: false,
                     waiting: false)
    }
}
