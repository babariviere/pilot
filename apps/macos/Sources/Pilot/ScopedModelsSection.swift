import Combine
import Foundation
import PilotCore
import SwiftUI

@MainActor final class ScopedModelsEditor: ObservableObject {
    @Published var allModels = true
    @Published var patterns: [String] = []
    @Published private(set) var initialized = false
    @Published private(set) var edited = false

    var selection: ScopedModelsSelection { allModels ? .all : .init(patterns: patterns) }
    var valid: Bool { (try? selection.validate()) != nil }

    func initialize(_ selection: ScopedModelsSelection) {
        guard !initialized else { return }
        load(selection)
    }
    func load(_ selection: ScopedModelsSelection) {
        allModels = selection.patterns == nil; patterns = selection.patterns ?? []
        initialized = true; edited = false
    }
    func setAll(_ value: Bool) { allModels = value; edited = true }
    func select(_ id: String, selected: Bool) {
        allModels = false
        if selected {
            if !patterns.contains(id) { patterns.append(id) }
        } else { patterns.removeAll { $0 == id } }
        edited = true
    }
    func add(_ pattern: String = "") { allModels = false; patterns.append(pattern); edited = true }
    func replace(_ index: Int, with text: String) { patterns[index] = text; edited = true }
    func remove(_ index: Int) { patterns.remove(at: index); edited = true }
    func move(_ index: Int, by offset: Int) {
        patterns.swapAt(index, index + offset); edited = true
    }
}

struct ScopedModelsHostRow: Identifiable {
    let host: HostRef
    let title: String
    let connected: Bool
    var id: HostRef { host }
}

/// Editor and host outcomes, independent of endpoint lifetime. HostClients owns sync outside Settings.
@MainActor struct ScopedModelsSection: View {
    @ObservedObject var sync: ScopedModelsSync
    let hosts: [ScopedModelsHostRow]
    let localHost: HostRef?
    @StateObject private var editor = ScopedModelsEditor()
    @State private var query = ""
    @State private var advanced = false
    @State private var candidateLimit = 30
    @State private var review: HostReview?

    private struct HostReview: Identifiable {
        let id = UUID()
        let row: ScopedModelsHostRow
        let consent: ScopedModelsSync.Consent
        let useEverywhere: Bool
    }

    private var localObservation: ScopedModelsObservation? { localHost.flatMap { sync.observations[$0] } }
    private var initialSelection: ScopedModelsSelection? { sync.state.desired ?? localObservation?.baseline.selection }

    var body: some View {
        SettingsSection("Scoped models", explanation: "Choose pi’s global model list on this Mac. Changes apply only when you save.") {
            SettingsToggle("All authenticated models", detail: "Use every authenticated model, including models added later.",
                isOn: Binding(get: { editor.allModels }, set: { editor.setAll($0) }))
                .disabled(!editor.initialized)
            if !editor.allModels {
                SettingsRow {
                    TextField("Search available models", text: $query).textFieldStyle(.roundedBorder)
                        .accessibilityLabel("Search available models")
                }
                SettingsRow { SettingsNote("Authenticated models on this Mac, including those outside the current scope. Unavailable patterns are preserved.") }
                let candidates = (localObservation?.candidates ?? []).filter {
                    query.isEmpty || "\($0.provider) \($0.id) \($0.name)".localizedCaseInsensitiveContains(query)
                }
                ForEach(Array(candidates.prefix(candidateLimit))) { candidate in
                    ScopedModelsCandidateRow(candidate: candidate, editor: editor)
                }
                if candidates.count > candidateLimit {
                    SettingsRow {
                        Button("Show more models (\(candidates.count - candidateLimit) remaining)") { candidateLimit += 30 }
                            .buttonStyle(.link)
                    }
                }
                if candidates.isEmpty {
                    SettingsRow { SettingsNote(localObservation == nil ? "Reconnect Local to load available models." : "No authenticated models match this search. Existing selections and advanced patterns are kept.") }
                }
                SettingsRow {
                    DisclosureGroup("Advanced patterns (\(editor.patterns.count))", isExpanded: $advanced) {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(editor.patterns.indices, id: \.self) { index in
                                SettingsRow {
                                    TextField("Literal model pattern", text: Binding(get: { editor.patterns[index] }, set: { editor.replace(index, with: $0) }))
                                        .textFieldStyle(.roundedBorder).accessibilityLabel("Model pattern \(index + 1)")
                                } control: {
                                    HStack(spacing: 6) {
                                        Button("Up") { editor.move(index, by: -1) }.disabled(index == 0)
                                        Button("Down") { editor.move(index, by: 1) }.disabled(index == editor.patterns.count - 1)
                                        Button("Remove") { editor.remove(index) }
                                    }.controlSize(.small)
                                }
                            }
                            Button("Add pattern") { editor.add() }.controlSize(.small).disabled(editor.patterns.count >= 256)
                            SettingsNote("Literal order, duplicates and thinking suffixes are preserved. Unavailable patterns are kept, not substituted. Wildcards can include additional models beyond the explicit selections above.")
                        }
                    }
                }
            }
            if let observation = localObservation {
                SettingsRow("Local baseline", detail: Self.describe(observation.baseline)) { EmptyView() }
                ForEach(Array(observation.resolution.enumerated()), id: \.offset) { _, value in
                    if let reason = value.reason {
                        SettingsRow(value.pattern, detail: "Unavailable on Local: \(reason). The pattern will be kept.") { EmptyView() }
                    }
                }
            } else if sync.state.desired == nil {
                SettingsRow { SettingsNote("Connect Local to read its baseline before the first Save. Opening Settings never writes pi settings.") }
            }
            SettingsRow { SettingsNote("Only global enabledModels is changed. Project .pi/settings.json overrides remain in effect and are not changed. Default models, sign-ins and running chats are untouched.") }
            SettingsRow {
                HStack(spacing: 8) {
                    ScopedModelsSaveButton(sync: sync, editor: editor, localHost: localHost)
                    Button("Revert") { if let initialSelection { editor.load(initialSelection) } }
                        .controlSize(.small).disabled(!editor.edited)
                }
            }
            if !editor.valid { SettingsRow { InlineProblem("Select at least one model or choose All. Advanced patterns must be nonempty and fit within 256 UTF-8 bytes.") } }
            if let problem = sync.problem { SettingsRow { InlineProblem(problem) } }
        }
        SettingsSection("Local status", explanation: "Saved changes are verified by reading pi’s settings back. Conflicting edits need your review.") {
            ForEach(hosts) { row in hostRow(row) }
        }
        .onAppear { initialize() }
        .onChange(of: sync.state.sequence) { _, _ in initialize() }
        .onChange(of: localObservation?.baseline) { _, _ in initialize() }
        .onChange(of: query) { _, _ in candidateLimit = 30 }
        .sheet(item: $review) { value in
            SheetScaffold(value.useEverywhere ? "Use current pi settings" : "Sync this host",
                subtitle: value.row.title,
                primary: SheetPrimaryAction(title: value.useEverywhere ? "Save new list" : "Apply saved list",
                    enabled: sync.isCurrent(value.consent),
                    action: {
                        Task {
                            if value.useEverywhere { await sync.useEverywhere(value.consent) }
                            else { await sync.join(value.consent) }
                            review = nil
                        }
                    }), cancel: { review = nil }, width: 480) {
                SettingsNote("Current host value: \(Self.describe(value.consent.baseline))")
                SettingsNote("Saved Mac list (revision \(value.consent.revision)): \(value.consent.desired.patterns?.joined(separator: ", ") ?? "All authenticated models")")
                SettingsNote(value.useEverywhere
                    ? "This creates a new saved Mac revision. The current pi settings become your saved list."
                    : "Replace only this host’s global model scope with the saved Mac list, using the shown baseline. A change elsewhere will require another review.")
                SettingsNote("No credentials, project overrides or other settings are copied.")
            }
        }
    }

    private func initialize() { if let initialSelection { editor.initialize(initialSelection) } }

    private func hostRow(_ row: ScopedModelsHostRow) -> some View {
        let entry = sync.state.entry(row.host)
        let observation = sync.observations[row.host]
        let status = entry?.status ?? .needsConsent
        let unavailable = (entry?.unresolved ?? []).map { "\($0.pattern): \($0.reason)" }.joined(separator: "; ")
        return SettingsRow(row.title, detail: "\(row.connected ? status.title : status == .divergent ? "Disconnected · left as is" : "Disconnected · pending")\(entry?.observed.map { " · " + Self.describe($0) } ?? "")\(unavailable.isEmpty ? "" : " · Unavailable patterns kept: " + unavailable)") {
            HStack(spacing: 8) {
                if sync.checking.contains(row.host) { ProgressView().controlSize(.small) }
                if let observation, sync.state.desired != nil {
                    Menu(status == .conflict ? "Resolve…" : "Options") {
                        Button(status == .conflict ? "Overwrite this host…" : "Join saved list…") {
                            if let consent = sync.review(row.host) { review = HostReview(row: row, consent: consent, useEverywhere: false) }
                        }.disabled(!observation.writable)
                        Button("Use current pi settings…") {
                            if let consent = sync.review(row.host) { review = HostReview(row: row, consent: consent, useEverywhere: true) }
                        }
                        Button("Leave as is") { Task { await sync.leave(row.host) } }
                    }.disabled(!row.connected || sync.checking.contains(row.host))
                }
                Button("Check") { sync.refresh(row.host) }.disabled(!row.connected || sync.checking.contains(row.host))
            }.controlSize(.small)
        }
    }

    static func describe(_ baseline: ScopedModelsBaseline) -> String {
        baseline.displaysAll ? "All authenticated models" : baseline.patterns!.joined(separator: ", ")
    }
}

@MainActor struct ScopedModelsCandidateRow: View {
    let candidate: ScopedModelsObservation.Candidate
    @ObservedObject var editor: ScopedModelsEditor

    var body: some View {
        SettingsRow(candidate.name, detail: "\(candidate.provider) · \(candidate.id)") {
            Toggle(candidate.name, isOn: Binding(get: { editor.patterns.contains(candidate.id) },
                set: { editor.select(candidate.id, selected: $0) }))
                .labelsHidden().toggleStyle(.checkbox).controlSize(.small)
                .background(ControlGeometry(id: "scoped-model-candidate"))
                .disabled(!editor.patterns.contains(candidate.id) && editor.patterns.count >= 256)
                .accessibilityLabel("Include \(candidate.name)")
        }
    }
}

/// Exact production Save control, independently mountable by the native dispatch fixture.
@MainActor struct ScopedModelsSaveButton: View {
    @ObservedObject var sync: ScopedModelsSync
    @ObservedObject var editor: ScopedModelsEditor
    let localHost: HostRef?
    @State private var saving = false

    private var enabled: Bool {
        editor.initialized && editor.valid && !saving && (sync.state.desired != nil || localHost.flatMap { sync.observations[$0] } != nil)
    }

    var body: some View {
        Button(saving ? "Saving…" : "Save") {
            saving = true
            let selection = editor.selection
            Task {
                defer { saving = false }
                var joining: [HostRef: ScopedModelsBaseline] = [:]
                if let localHost, sync.state.entry(localHost)?.baseline == nil, let observation = sync.observations[localHost] {
                    joining[localHost] = observation.baseline
                }
                await sync.save(selection, joining: joining)
                if sync.problem == nil, editor.selection == selection { editor.load(selection) }
            }
        }.controlSize(.small)
            .background(ControlGeometry(id: "scoped-model-save"))
            .disabled(!enabled).accessibilityIdentifier("scoped-models-save")
    }
}
