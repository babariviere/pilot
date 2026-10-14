import AppKit
import PilotCore
import SwiftUI

// Project settings → Tracking: attach a Linear team and pick Slack channels. Lookups are read-only MCP calls
// made by pilotd; nothing is tracked until the project is saved.

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
        Section {
            LinearTeamPicker(selection: $editor.linearTeam,
                             source: client.source(projectId: project.id, kind: .linear),
                             saved: project.tracking?.linearTeam)
            SlackChannelsEditor(editor: editor,
                                source: client.source(projectId: project.id, kind: .slack),
                                saved: Set(project.tracking?.slackChannels ?? []), query: channelQuery)
        } header: {
            Text("Tracking")
        } footer: {
            SettingsFooter("Pilot reads your Linear issues and Slack bug reports through your pi MCP servers. It never posts, comments or changes tickets, and never starts work on its own.")
        }
    }
}

/// Linear team picker from list_teams. Attaching a team shows my issues in it (and its sub-teams) and its
/// current cycle on the project page.
struct LinearTeamPicker: View {
    @Binding var selection: TrackedTeamRef?
    let source: TrackingSource?
    let saved: String?
    @ObservedObject private var client = AppModel.shared.client
    @ObservedObject private var signIns = AppModel.shared.client.sourceSignIns
    @State private var lookup: TrackingLookup<LinearTeamOption>?
    @State private var loading = false

    private var teams: [LinearTeamOption] { lookup?.items ?? [] }

    var body: some View {
        LabeledContent {
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
        } label: {
            Text("Linear team")
            Text(detail).font(.caption).foregroundStyle(.secondary)
        }
        .task { await load(force: false) }
        .onChange(of: signIns[.linear]?.state) { _, state in
            if state == .done { Task { await load(force: true) } }
        }
        if let lookup, lookup.status == .error {
            TrackingLookupProblem(service: "Linear", lookup: lookup) { Task { await load(force: true) } }
        }
        SourceAccountRow(kind: .linear, label: "Linear",
                         needsSignIn: lookup?.status == .signInRequired || source?.status == .signInRequired,
                         connected: lookup?.status == .ok || source?.status == .ok || source?.status == .syncing,
                         purpose: "Sign in to pick a team and read your issues.")
    }

    private var binding: Binding<String> {
        Binding(get: { selection?.id ?? "" }, set: { id in
            selection = id.isEmpty ? nil
                : TrackedTeamRef(id: id, name: teams.first { $0.id == id }?.name ?? selection?.name)
        })
    }

    private var detail: String {
        guard let selection else { return "Attach a team to track your issues in it, including its sub-teams." }
        guard selection.id == saved, let source, source.configured else { return "Save to start tracking." }
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
        LabeledContent {
            EmptyView()
        } label: {
            Text("Slack channels")
            Text(editor.slackChannels.isEmpty ? "Add the channels where bugs are reported. New messages are classified with a small model."
                : "Each channel is read from the moment you add it, with a short look back.")
                .font(.caption).foregroundStyle(.secondary)
        }
        ForEach(editor.slackChannels) { channel in
            SlackChannelRow(channel: channel, status: source?.channels?.first { $0.id == channel.id },
                            saved: saved.contains(channel.id)) { editor.removeChannel(channel.id) }
        }
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary).accessibilityHidden(true)
            TextField("Add channel", text: $query, prompt: Text("Search channels to add"))
                .textFieldStyle(.plain)
                .labelsHidden()
                .focused($focused)
                .onSubmit { if let first = candidates.first { add(first) } }
            if searching { ProgressView().controlSize(.small) }
        }
        if focused || !query.isEmpty {
            suggestions
        }
        SourceAccountRow(kind: .slack, label: "Slack",
                         needsSignIn: mine?.status == .signInRequired || results?.status == .signInRequired
                             || source?.status == .signInRequired,
                         connected: mine?.status == .ok || results?.status == .ok || source?.status == .ok
                             || source?.status == .syncing,
                         purpose: "Sign in to find channels and read bug reports.")
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
            Text(query.isEmpty ? "Channels you're in" : "Matching channels").font(.caption).foregroundStyle(.secondary)
            ForEach(candidates.prefix(6)) { option in
                HStack(spacing: 6) {
                    Image(systemName: option.isPrivate ? "lock" : "number").font(.caption).foregroundStyle(.secondary)
                        .frame(width: 14)
                        .accessibilityLabel(option.isPrivate ? "Private channel" : "Channel")
                    Text(option.name).lineLimit(1)
                    Spacer(minLength: 8)
                    Button("Add") { add(option) }.controlSize(.small)
                }
                .padding(.vertical, 2)
            }
            if let lookup, lookup.status == .signInRequired {
                Text("Sign in to Slack below to search channels.").font(.caption).foregroundStyle(.secondary)
            } else if let lookup, lookup.status != .ok {
                TrackingLookupProblem(service: "Slack", lookup: lookup) { retry() }
            } else if candidates.isEmpty, !searching, lookup != nil {
                Text(query.isEmpty ? "No more channels to suggest. Search to find others." : "No channels match.")
                    .font(.caption).foregroundStyle(.secondary)
            } else if lookup?.more == true || candidates.count > 6 {
                Text("Refine the search to see more.").font(.caption).foregroundStyle(.secondary)
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
                    Image(systemName: "exclamationmark.triangle").accessibilityHidden(true)
                }
                Text(line.text)
            }
            .font(.caption)
            .foregroundStyle(line.tone == .attention ? Theme.blocked : Color.secondary)
            .help(status?.error ?? (status?.status == .signInRequired ? "Sign in to Slack below." : line.text))
            Button(action: remove) { Image(systemName: "minus.circle") }
                .buttonStyle(QuietIconButtonStyle(hoverTint: Theme.destructive))
                .help("Stop tracking \(channel.display)")
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
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(Theme.blocked)
                .accessibilityHidden(true)
            Text(lookup.error ?? "Couldn't reach \(service).").foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            Button("Retry", action: retry).controlSize(.small)
        }
        .font(.caption)
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
        LabeledContent {
            HStack(spacing: 6) {
                if state.waiting { ProgressView().controlSize(.small) }
                SourceSignInButton(kind: kind, label: label, again: !needsSignIn)
            }
        } label: {
            Text("\(label) account")
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                if state.attention {
                    Image(systemName: "person.crop.circle.badge.exclamationmark").accessibilityHidden(true)
                }
                Text(state.text).fixedSize(horizontal: false, vertical: true)
            }
            .font(.caption)
            .foregroundStyle(state.attention ? Theme.blocked : Color.secondary)
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
