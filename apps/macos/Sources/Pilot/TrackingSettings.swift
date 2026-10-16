import AppKit
import PilotCore
import SwiftUI

// Project settings → Tracking: attach a Linear team, pick Slack channels and define the labels Slack messages
// are sorted into, with each source's triage guide and recent corrections. Lookups are read-only MCP calls made by
// pilotd; nothing is tracked until the project is saved.

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
        if editor.linearTeam != nil {
            LinearSizesSection(projectId: project.id)
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

/// Configured Slack channels with their status and a remove button, then the field that adds more, right below the
/// list so it reads as the next step. Suggestions come from the channels I'm in; typing searches public and private
/// channels I can read. Group handles only matter for mention-only channels, so they appear once one is filtered.
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
                VStack(alignment: .leading, spacing: 8) {
                    SlackChannelRow(channel: channel, status: source?.channels?.first { $0.id == channel.id },
                                    saved: saved.contains(channel.id)) { editor.removeChannel(channel.id) }
                    Toggle("Only messages that mention me", isOn: Binding(
                        get: { editor.slackMentionOnlyChannels.contains(channel.id) },
                        set: { if $0 { editor.slackMentionOnlyChannels.insert(channel.id) }
                               else { editor.slackMentionOnlyChannels.remove(channel.id) } }
                    ))
                    .font(.pilot(.caption))
                    .help("A personal or group mention anywhere in a thread qualifies it. Searches only this channel, public or private. Existing items stay unchanged.")
                    .accessibilityLabel("Only messages that mention me in \(channel.display)")
                }
            }
        }
        SettingsRow {
            HStack(spacing: 6) {
                PilotSymbol(PilotIcon.add).foregroundStyle(Theme.mutedForeground).accessibilityHidden(true)
                TextField("Add channel", text: $query, prompt: Text("Add a channel: search by name"))
                    .textFieldStyle(.plain)
                    .font(.pilot(.label))
                    .labelsHidden()
                    .focused($focused)
                    .onSubmit { if let first = candidates.first { add(first) } }
                if searching { ProgressView().controlSize(.small) }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: Theme.Radius.control).fill(Theme.card))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control)
                .strokeBorder(focused ? Theme.focusRing : Theme.border))
            .contentShape(Rectangle())
            .onTapGesture { focused = true }
        }
        if focused || !query.isEmpty {
            SettingsRow { suggestions }
        }
        if showsGroupHandles {
            SettingsRow {
                SettingsRowLabel(title: "My Slack groups",
                                 detail: "Mention-only channels also keep messages that mention these groups.")
            } control: {
                TextField("@support, @oncall", text: $editor.slackGroupHandles)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 200)
                    .accessibilityLabel("My Slack group handles, separated by commas")
                    .help("Group handles you belong to, separated by commas. Slack cannot list your memberships. Personal mentions always count; @here, @channel and @everyone do not.")
            }
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

    /// Group handles only filter mention-only channels; keep them visible while any are saved so they can be cleared.
    private var showsGroupHandles: Bool {
        let channels = Set(editor.slackChannels.map(\.id))
        return !editor.slackMentionOnlyChannels.isDisjoint(with: channels)
            || !editor.slackGroupHandles.trimmingCharacters(in: .whitespaces).isEmpty
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

/// Labels Slack messages are sorted into, defined per project, then the triage guide and the latest corrections. The
/// classifier reads each label's name and description and picks at most one. Effects hide or close messages locally.
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
            TriageGuideSection(projectId: project.id, kind: .slack)
            TriageCorrectionsList(projectId: project.id, kind: .slack)
        }
    }
}

/// How Pilot sizes Linear issues, shown once a team is attached: the triage guide built from the user's size
/// corrections, then the latest corrections. Sizes are corrected from an issue's row, not here.
struct LinearSizesSection: View {
    let projectId: String

    var body: some View {
        SettingsSection("Linear sizes", explanation: "A small model estimates each of your issues as Quick fix or Needs planning. Correct a size from the issue's row, and Pilot sizes similar issues the same way.") {
            TriageGuideSection(projectId: projectId, kind: .linear)
            TriageCorrectionsList(projectId: projectId, kind: .linear)
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

/// A source's triage guide: the short rules pilotd's grooming model writes from the project's corrections, when they
/// were last updated, and Rebuild, which folds the latest corrections in now. Read-only: the rules are untrusted model
/// output, shown as plain text, and change only through corrections. A saved guide replaces the rows in place.
struct TriageGuideSection: View {
    let projectId: String
    let kind: TrackedKind
    @StateObject private var model: TriageGuideModel
    @State private var expanded = false
    private static let shown = 5

    init(projectId: String, kind: TrackedKind) {
        self.projectId = projectId
        self.kind = kind
        _model = StateObject(wrappedValue: TriageGuideModel(kind: kind))
    }

    var body: some View {
        let rules = TriageGuideText.rules(model.guide?.text ?? "")
        let visible = expanded ? rules : Array(rules.prefix(Self.shown))
        SettingsSubheading("Triage guide", note: TriageGuideText.note(model.guide, rebuild: model.rebuild, kind: kind)) {
            TriageGuideRebuildControl(busy: model.rebuild.isBusy) { model.requestRebuild() }
        }
        .help(TriageGuideText.tooltip(model.guide))
        .onAppear { model.start(client: AppModel.shared.client, projectId: projectId) }
        .onChange(of: projectId) { _, id in model.start(client: AppModel.shared.client, projectId: id) }
        .onDisappear { model.stop() }
        if model.guide == nil, model.loadFailed {
            SettingsRow { InlineProblem("Couldn't load the triage guide.") { model.reload() } }
        } else if model.guide != nil, rules.isEmpty {
            SettingsRow {
                Text(TriageGuideText.empty).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        ForEach(Array(visible.enumerated()), id: \.offset) { _, rule in
            SettingsRow {
                Text(verbatim: rule).font(.pilot(.body)).foregroundStyle(Theme.foreground)
                    .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        if rules.count > Self.shown {
            SettingsRow { ListToggle(total: rules.count, expanded: $expanded, noun: "rules") }
        }
        if let error = model.rebuildError {
            SettingsRow { InlineProblem(error) { model.requestRebuild() } }
        }
    }
}

/// Rebuild, or the ellipsis spinner and "Rebuilding…" while pilotd works on it.
private struct TriageGuideRebuildControl: View {
    let busy: Bool
    let action: () -> Void

    var body: some View {
        if busy {
            HStack(spacing: 5) {
                EllipsisSpinner()
                Text("Rebuilding…").font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Rebuilding the triage guide")
        } else {
            Button("Rebuild", action: action)
                .controlSize(.small)
                .help("Fold your latest corrections into the guide now")
                .accessibilityLabel("Rebuild the triage guide")
        }
    }
}

/// Where a Rebuild request stands.
enum TriageGuideRebuild: Equatable {
    case idle
    /// The request is on its way to pilotd.
    case requesting
    /// Queued; done once a guide newer than `since` arrives.
    case waiting(since: Double)
    /// Still queued after `rebuildPatience`, such as behind pilotd's throttle or a retry. Rebuild is offered again.
    case queued(since: Double)

    var isBusy: Bool {
        switch self {
        case .requesting, .waiting: true
        case .idle, .queued: false
        }
    }
}

/// One source's guide for one project, reloaded when pilotd reports a tracking change for the project (a saved guide
/// sends one), never polled. Rebuild queues a run in pilotd (202) and waits for a guide newer than the one it returned.
@MainActor
final class TriageGuideModel: ObservableObject {
    let kind: TrackedKind
    @Published private(set) var guide: TriageGuide?
    @Published private(set) var loadFailed = false
    @Published private(set) var rebuild: TriageGuideRebuild = .idle
    @Published private(set) var rebuildError: String?
    private var projectId: String?
    private weak var client: PilotClient?
    private var observer: UUID?
    private var loading: Task<Void, Never>?
    private var request: Task<Void, Never>?
    private var patience: Task<Void, Never>?
    /// pilotd bounds one grooming run to 90 s, so a rebuild still pending after this waits for a later run.
    static let rebuildPatience: Duration = .seconds(120)

    init(kind: TrackedKind) { self.kind = kind }

    func start(client: PilotClient, projectId: String) {
        if self.projectId != projectId {
            stop()
            self.projectId = projectId
            guide = nil
            loadFailed = false
            rebuild = .idle
            rebuildError = nil
        }
        self.client = client
        if observer == nil {
            observer = client.observeTrackedItems { [weak self] changed in
                guard let self, changed == self.projectId else { return }
                self.reload(after: .milliseconds(300))
            }
        }
        reload()
    }

    func stop() {
        if let observer { client?.stopObservingTrackedItems(observer) }
        observer = nil
        loading?.cancel()
        request?.cancel()
        patience?.cancel()
        // Nothing finishes these once stopped: a request in flight is dropped, a wait resumes as queued.
        switch rebuild {
        case .requesting: rebuild = .idle
        case let .waiting(since): rebuild = .queued(since: since)
        case .idle, .queued: break
        }
    }

    /// Latest wins. A shown guide stays until the new one arrives, and stays on failure.
    func reload(after delay: Duration = .zero) {
        loading?.cancel()
        loading = Task { [weak self] in
            if delay > .zero { try? await Task.sleep(for: delay) }
            guard !Task.isCancelled, let self, let client = self.client, let projectId = self.projectId else { return }
            do {
                let guide = try await client.triageGuide(projectId: projectId, kind: self.kind)
                guard !Task.isCancelled, projectId == self.projectId else { return }
                self.apply(guide)
                if self.loadFailed { self.loadFailed = false }
            } catch {
                guard !Task.isCancelled, projectId == self.projectId else { return }
                self.loadFailed = true
            }
        }
    }

    func requestRebuild() {
        guard let client, let projectId, !rebuild.isBusy else { return }
        let kind = kind
        rebuild = .requesting
        rebuildError = nil
        request = Task { [weak self] in
            do {
                let before = try await client.rebuildTriageGuide(projectId: projectId, kind: kind)
                guard let self, !Task.isCancelled, projectId == self.projectId else { return }
                self.rebuild = .waiting(since: before.updatedAt)
                self.apply(before)
                self.armPatience(since: before.updatedAt)
            } catch {
                guard let self, !Task.isCancelled, projectId == self.projectId else { return }
                self.rebuild = .idle
                self.rebuildError = TriageGuideText.rebuildFailed(error.localizedDescription)
            }
        }
    }

    /// Done once a guide newer than the one the rebuild request returned arrives.
    nonisolated static func settle(_ state: TriageGuideRebuild, with guide: TriageGuide) -> TriageGuideRebuild {
        switch state {
        case let .waiting(since), let .queued(since): guide.updatedAt > since ? .idle : state
        case .idle, .requesting: state
        }
    }

    private func apply(_ guide: TriageGuide) {
        if self.guide != guide { self.guide = guide }
        let next = Self.settle(rebuild, with: guide)
        guard next != rebuild else { return }
        rebuild = next
        if next == .idle { patience?.cancel() }
    }

    private func armPatience(since: Double) {
        patience?.cancel()
        patience = Task { [weak self] in
            try? await Task.sleep(for: Self.rebuildPatience)
            guard let self, !Task.isCancelled, self.rebuild == .waiting(since: since) else { return }
            self.rebuild = .queued(since: since)
        }
    }
}

/// Wording of the triage guide, kept apart from the view for tests.
enum TriageGuideText {
    /// pilotd's limit on guide rules.
    static let maxRules = 40
    static let empty = "No rules yet. Pilot writes them after a few corrections, or when you choose Rebuild."

    /// One rule per line, blank lines dropped.
    static func rules(_ text: String) -> [String] {
        Array(text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .prefix(maxRules))
    }

    /// "Updated 3 hours ago. Rules Pilot writes from …", or "Rebuild queued. …" while a rebuild waits.
    static func note(_ guide: TriageGuide?, rebuild: TriageGuideRebuild, kind: TrackedKind,
                     now: Date = Date()) -> String {
        let source = kind == .slack ? "your corrections in Slack triage" : "your Linear size corrections"
        let about = "Rules Pilot writes from \(source). The classifier reads them with your latest five corrections."
        if case .queued = rebuild { return "Rebuild queued. \(about)" }
        guard let guide, guide.updatedAt > 0 else { return about }
        return "Updated \(RelativeDate.sentence(guide.updatedAt, now: now)). \(about)"
    }

    /// The exact update time, for the heading's tooltip.
    static func tooltip(_ guide: TriageGuide?) -> String {
        guard let guide, guide.updatedAt > 0 else { return "" }
        return "Updated \(RelativeDate.exact(guide.updatedAt))"
    }

    static func rebuildFailed(_ reason: String) -> String {
        let reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        return reason.isEmpty ? "Couldn't start a rebuild." : "Couldn't start a rebuild: \(reason)"
    }

    /// The note under "Recent corrections": where corrections come from while there are none.
    static func correctionsNote(empty: Bool, kind: TrackedKind) -> String {
        guard empty else { return "Newest first. Pilot keeps the latest 500 for the guide." }
        return kind == .slack ? "Changes you make in Slack triage appear here." : "Sizes you correct on Linear issues appear here."
    }
}

/// A source's corrections for the project, newest first: five, then 25 more at a time. Read-only; they change as the
/// user reclassifies Slack messages or corrects Linear sizes. pilotd keeps the latest 500 per source.
private struct TriageCorrectionsList: View {
    /// What was corrected (message summary or issue title) and what the user changed it to.
    struct Row {
        let summary: String
        let change: String
    }

    let projectId: String
    let kind: TrackedKind
    @ObservedObject private var client = AppModel.shared.client
    @State private var corrections: [Row]?
    @State private var failed = false
    @State private var visibleCount = Self.shown
    private static let shown = 5
    private static let page = 25

    var body: some View {
        let items = corrections ?? []
        SettingsSubheading("Recent corrections",
                           note: TriageGuideText.correctionsNote(empty: corrections != nil && items.isEmpty, kind: kind))
            .task(id: projectId) { await load() }
        if failed, corrections == nil {
            SettingsRow { InlineProblem("Couldn't load your corrections.") { Task { await load() } } }
        }
        ForEach(Array(items.prefix(visibleCount).enumerated()), id: \.offset) { _, correction in
            SettingsRow {
                Text(verbatim: correction.summary).font(.pilot(.body)).foregroundStyle(Theme.foreground)
                    .lineLimit(1).truncationMode(.tail)
            } control: {
                Text(correction.change).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    .lineLimit(1).fixedSize()
            }
            .accessibilityElement(children: .combine)
        }
        if items.count > Self.shown {
            SettingsRow {
                HStack(spacing: 14) {
                    if items.count > visibleCount {
                        moreButton("Show \(min(Self.page, items.count - visibleCount)) more") {
                            visibleCount += Self.page
                        }
                    }
                    if visibleCount > Self.shown {
                        moreButton("Show fewer") { visibleCount = Self.shown }
                    }
                }
            }
        }
    }

    private func moreButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.pilot(.caption))
                .foregroundStyle(Theme.mutedForeground)
                .contentShape(Rectangle())
        }
        .rowButtonStyle(outset: 2)
    }

    private func load() async {
        do {
            switch kind {
            case .slack:
                corrections = try await client.slackCorrections(projectId: projectId).map {
                    Row(summary: $0.summary, change: SlackTriageText.correction($0.values))
                }
            case .linear:
                corrections = try await client.linearSizeCorrections(projectId: projectId).map {
                    Row(summary: $0.summary, change: $0.values.size.title)
                }
            }
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
