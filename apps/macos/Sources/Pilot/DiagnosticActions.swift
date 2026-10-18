import Foundation
import PilotCore
import PilotTelemetry
import SwiftUI

struct DiagnosticRepairTarget: Identifiable {
    let specialist: SessionSummary
    let reference: HostResourceRef
    var id: String { reference.storageKey }
}

struct DiagnosticSetupTarget: Identifiable {
    let id = UUID()
    let reference: HostResourceRef
    let askingAboutPilot: Bool
    let tracksFeature: Bool
}

struct DiagnosticResolvedTarget {
    let reference: HostResourceRef
    let session: SessionSummary
}

enum DiagnosticTargetResolutionError: LocalizedError, Equatable {
    case malformed, missing, ambiguous, specialist, unavailable

    var errorDescription: String? {
        switch self {
        case .malformed: "Enter a complete Pilot chat link, such as pilot://chat/…"
        case .missing: "That chat is not available on any known host."
        case .ambiguous: "That link matches chats on more than one host. Open the intended chat and use Diagnose this chat."
        case .specialist: "A diagnostics specialist cannot diagnose another diagnostics specialist."
        case .unavailable: "Reconnect to this chat's host before starting diagnostics."
        }
    }
}

enum DiagnosticSetup {
    static func link(_ sessionId: String) -> String { "pilot://chat/\(sessionId.lowercased())" }

    static func available(_ reference: HostResourceRef, localHost: HostRef?, localConnected: Bool,
                          availableHosts: Set<HostRef>) -> Bool {
        reference.host == localHost ? localConnected : availableHosts.contains(reference.host)
    }

    static func resolve(_ value: String, setup: DiagnosticSetupTarget, localHost: HostRef?,
                        local: [SessionSummary], hosted: [Hosted<SessionSummary>]) throws -> DiagnosticResolvedTarget {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let initial = link(setup.reference.localId)
        if text.isEmpty || text.caseInsensitiveCompare(initial) == .orderedSame {
            if text.isEmpty && !setup.askingAboutPilot { throw DiagnosticTargetResolutionError.malformed }
            if setup.reference.host == localHost,
               let session = local.first(where: { $0.id == setup.reference.localId }) {
                if session.isDiagnosticsSpecialist { throw DiagnosticTargetResolutionError.specialist }
                return DiagnosticResolvedTarget(reference: setup.reference, session: session)
            }
            if let target = hosted.first(where: { $0.ref == setup.reference }) {
                if target.value.isDiagnosticsSpecialist { throw DiagnosticTargetResolutionError.specialist }
                return DiagnosticResolvedTarget(reference: target.ref, session: target.value)
            }
            throw DiagnosticTargetResolutionError.missing
        }
        guard let url = URL(string: text), let destination = ChatDestination(url: url) else {
            throw DiagnosticTargetResolutionError.malformed
        }
        var matches: [DiagnosticResolvedTarget] = []
        if let localHost, let session = local.first(where: { $0.id == destination.sessionId }) {
            matches.append(DiagnosticResolvedTarget(
                reference: HostResourceRef(host: localHost, kind: .session, localId: session.id), session: session
            ))
        }
        matches += hosted.filter { $0.value.id == destination.sessionId }.map {
            DiagnosticResolvedTarget(reference: $0.ref, session: $0.value)
        }
        let unique = Dictionary(grouping: matches, by: \.reference).compactMap(\.value.first)
        guard unique.count == 1, let result = unique.first else {
            throw unique.isEmpty ? DiagnosticTargetResolutionError.missing : DiagnosticTargetResolutionError.ambiguous
        }
        if result.session.isDiagnosticsSpecialist { throw DiagnosticTargetResolutionError.specialist }
        return result
    }

    static func spawnRequest(target: DiagnosticResolvedTarget, model: String, thinking: String,
                             askingAboutPilot: Bool) throws -> SpawnRequest {
        guard let admitted = DiagnosticTargetReference(host: target.reference.host,
                                                       sessionId: target.reference.localId) else {
            throw HostRoutingError.invalidReference
        }
        let message = askingAboutPilot
            ? "Open an Ask about Pilot diagnostics conversation for the canonical target \(admitted.chatURL) on host \(admitted.host.hostId). Use the diagnostics tool for that admitted target without asking for its reference. Inspect only bounded operational evidence, cite evidence refs, distinguish observations from likely causes, and do not retry, restart, replay, or change the target."
            : "Diagnose the canonical target chat \(admitted.chatURL) on host \(admitted.host.hostId). Use the diagnostics tool for that admitted target without asking for its reference. Inspect only bounded operational evidence, cite evidence refs, distinguish observations from likely causes, and do not retry, restart, replay, or change the target."
        return SpawnRequest(message: message, title: "Pilot diagnostics",
                            model: model.isEmpty ? nil : model, thinking: thinking.isEmpty ? nil : thinking,
                            mode: .ask, role: .diagnostics, diagnosticTarget: admitted)
    }
}

struct DiagnosticSpecialistHeader: View {
    let target: DiagnosticTargetReference?
    let fallbackTargetId: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            PilotSymbol(PilotIcon.bug).foregroundStyle(Theme.mutedForeground).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text("Diagnostics specialist")
                    .font(.pilot(.body, weight: .semibold)).foregroundStyle(Theme.foreground)
                    .accessibilityAddTraits(.isHeader)
                Text(summary).font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private var summary: String {
        if let target { return "Read-only operational evidence for \(target.chatURL) on \(target.host.hostId)" }
        if let fallbackTargetId { return "Read-only operational evidence for \(DiagnosticSetup.link(fallbackTargetId))" }
        return "Read-only bounded operational evidence"
    }
}

enum DiagnosticRepair {
    static func spawnRequest(handoff: DiagnosticsHandoff, fallbackCwd: String) throws -> SpawnRequest {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let material = String(decoding: try encoder.encode(handoff), as: UTF8.self)
        return SpawnRequest(
            projectId: handoff.projectId, cwd: handoff.projectId == nil ? fallbackCwd : nil,
            message: "Investigate and repair the diagnosed issue. Use only the user-authorized diagnostics handoff below as operational evidence. Verify the likely cause, add the requested regression coverage, and do not retry, restart, replay, or mutate the diagnosed chat.\n\n\(material)",
            title: "Repair diagnosed issue", mode: .build
        )
    }
}

extension AppModel {
    func isDiagnosing(_ session: SessionSummary, context: HostViewContext?) -> Bool {
        guard let ref = resourceRef(session.id, kind: .session, context: context) else { return false }
        return diagnosingSessions.contains(ref.storageKey)
    }

    func diagnose(_ session: SessionSummary, context: HostViewContext? = nil, askingAboutPilot: Bool = false) {
        guard !session.isDiagnosticsSpecialist,
              let target = resourceRef(session.id, kind: .session, context: context),
              !diagnosingSessions.contains(target.storageKey) else { return }
        let askingAboutPilot = askingAboutPilot || session.isControl
        let tracksFeature = !askingAboutPilot
        if tracksFeature { PilotTelemetry.shared.recordFeature(.attempt(.diagnoseChat)) }
        diagnosticSetupTarget = DiagnosticSetupTarget(reference: target, askingAboutPilot: askingAboutPilot,
                                                      tracksFeature: tracksFeature)
    }

    /// The Help menu diagnoses the control chat on the currently viewed host. It never falls back across hosts.
    func askAboutPilot() {
        if let selected = hosts.selection, selected.host != localHost {
            guard let control = hosts.sessions.first(where: { $0.ref.host == selected.host && $0.value.isControl }) else {
                sessionActionError = "Ask about Pilot is not available for the selected host."
                return
            }
            diagnose(control.value, context: HostViewContext(host: selected.host, hosts: hosts), askingAboutPilot: true)
        } else {
            guard let control = client.sessions.first(where: \.isControl) else {
                sessionActionError = "Pilot diagnostics are not available until the local daemon is connected."
                return
            }
            diagnose(control, askingAboutPilot: true)
        }
    }

    func spawnDiagnostics(_ request: SpawnRequest, target: HostResourceRef, tracksFeature: Bool) async throws -> HostResourceRef {
        guard !diagnosingSessions.contains(target.storageKey) else { throw ClientError("Diagnostics are already starting.") }
        diagnosingSessions.insert(target.storageKey)
        defer { diagnosingSessions.remove(target.storageKey) }
        do {
            let created: HostResourceRef
            if target.host == localHost {
                let specialist = try await client.spawn(request)
                guard let localHost else { throw HostRoutingError.invalidReference }
                created = HostResourceRef(host: localHost, kind: .session, localId: specialist.id)
            } else {
                created = try await createHostedSession(request, on: target.host)
            }
            if tracksFeature, let event = FeatureEvent.outcome(.diagnoseChat, .success, reason: .none) {
                PilotTelemetry.shared.recordFeature(event)
            }
            return created
        } catch {
            if tracksFeature {
                let disconnected = target.host != localHost && !hosts.available.contains(target.host)
                let event = disconnected
                    ? FeatureEvent.outcome(.diagnoseChat, .unavailable, reason: .disconnected)
                    : FeatureEvent.outcome(.diagnoseChat, .failure, reason: .unknown)
                if let event { PilotTelemetry.shared.recordFeature(event) }
            }
            throw error
        }
    }

    func canPrepareDiagnosticRepair(_ specialist: SessionSummary, context: HostViewContext?) -> Bool {
        guard specialist.isDiagnosticsSpecialist, let targetId = specialist.diagnosticTargetId else { return false }
        let client = context.map { $0.hosts.presentationClient($0.host) } ?? self.client
        guard let target = client.session(targetId) else { return false }
        return !target.isControl
    }

    func prepareDiagnosticRepair(_ specialist: SessionSummary, context: HostViewContext?) {
        guard canPrepareDiagnosticRepair(specialist, context: context),
              let reference = resourceRef(specialist.id, kind: .session, context: context) else { return }
        diagnosticRepairTarget = DiagnosticRepairTarget(specialist: specialist, reference: reference)
    }
}

struct DiagnosticSetupSheet: View {
    let setup: DiagnosticSetupTarget
    @EnvironmentObject private var app: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var link: String
    @State private var selectedModel = ""
    @State private var thinking = ""
    @State private var models = ModelList(models: [])
    @State private var loadingModels = true
    @State private var modelError: String?
    @State private var startError: String?
    @State private var busy = false

    init(setup: DiagnosticSetupTarget) {
        self.setup = setup
        _link = State(initialValue: setup.askingAboutPilot ? "" : DiagnosticSetup.link(setup.reference.localId))
    }

    private var resolved: DiagnosticResolvedTarget? {
        try? DiagnosticSetup.resolve(link, setup: setup, localHost: app.localHost,
                                     local: app.client.sessions, hosted: app.hosts.sessions)
    }

    private var resolutionError: String? {
        do {
            _ = try DiagnosticSetup.resolve(link, setup: setup, localHost: app.localHost,
                                            local: app.client.sessions, hosted: app.hosts.sessions)
            return nil
        } catch { return error.localizedDescription }
    }

    private var available: Bool {
        guard let resolved else { return false }
        return DiagnosticSetup.available(resolved.reference, localHost: app.localHost,
                                         localConnected: app.client.connected,
                                         availableHosts: app.hosts.available)
    }

    private var chosenOption: ModelOption? {
        let id = selectedModel.isEmpty ? models.defaultModel : selectedModel
        return id.flatMap { value in models.models.first { $0.id == value } }
    }

    private var canStart: Bool {
        guard !busy, resolved != nil, available, !loadingModels, modelError == nil, !models.models.isEmpty else { return false }
        if !selectedModel.isEmpty, !models.models.contains(where: { $0.id == selectedModel }) { return false }
        return thinking.isEmpty || (chosenOption?.thinkingLevels ?? []).contains(thinking)
    }

    var body: some View {
        SheetScaffold(setup.askingAboutPilot ? "Ask about Pilot" : "Diagnose this chat",
                      subtitle: "Start a read-only diagnostics specialist for one exact chat.",
                      error: startError,
                      primary: SheetPrimaryAction(title: busy ? "Starting…" : "Start diagnostics",
                                                  enabled: canStart, action: start),
                      cancel: { dismiss() }, width: 520) {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Target chat link").font(.pilot(.headline))
                    TextField("pilot://chat/…", text: $link)
                        .textFieldStyle(.roundedBorder)
                        .disabled(busy)
                    if setup.askingAboutPilot && link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text("No link uses the Pilot control chat on the current host.")
                            .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    }
                    if let resolved {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(resolved.session.title).foregroundStyle(Theme.foreground)
                                Text("\(hostName(resolved.reference.host)) · \(DiagnosticSetup.link(resolved.session.id))")
                                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                            }
                        } icon: { PilotSymbol(PilotIcon.chats, context: .inline) }
                    }
                    if let resolutionError { Text(resolutionError).font(.pilot(.caption)).foregroundStyle(Theme.destructive) }
                    else if !available {
                        Text(DiagnosticTargetResolutionError.unavailable.localizedDescription)
                            .font(.pilot(.caption)).foregroundStyle(Theme.destructive)
                    }
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("Model and thinking").font(.pilot(.headline))
                    HStack(spacing: 8) {
                        ModelMenu(model: $selectedModel, projectDefault: models.defaultModel, list: models)
                        ThinkingMenu(thinking: $thinking,
                                     levels: chosenOption?.thinkingLevels ?? ["off"],
                                     help: "Thinking level for this diagnostics chat")
                        if loadingModels { ProgressView().controlSize(.mini) }
                    }
                    .disabled(busy || loadingModels)
                    if let modelError { InlineProblem(modelError) { Task { await loadModels() } } }
                }

                Text("The linked chat is not opened, changed, restarted, retried, or added as transcript context. The specialist receives only its canonical reference and bounded operational evidence.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .task(id: "\(resolved?.reference.storageKey ?? "missing"):\(available)") { await loadModels() }
        .onChange(of: selectedModel) { _, _ in thinking = "" }
        .interactiveDismissDisabled(busy)
    }

    private func hostName(_ host: HostRef) -> String {
        host == app.localHost ? "Local" : (app.hosts.offlineHosts[host]?.configuration.alias ?? "Devbox")
    }

    private func loadModels() async {
        guard let target = resolved, available else {
            models = ModelList(models: []); modelError = nil; loadingModels = false; return
        }
        let key = target.reference.storageKey
        loadingModels = true; modelError = nil; selectedModel = ""; thinking = ""
        do {
            let list: ModelList
            if target.reference.host == app.localHost {
                list = try await app.client.models(projectId: target.session.projectId,
                                                   cwd: target.session.projectId == nil ? target.session.cwd : nil)
            } else {
                list = try await app.hosts.perform(target.reference, kind: .session) { client, _ in
                    try await client.models(projectId: target.session.projectId,
                                            cwd: target.session.projectId == nil ? target.session.cwd : nil)
                }
            }
            guard !Task.isCancelled, resolved?.reference.storageKey == key else { return }
            models = list
        } catch {
            guard !Task.isCancelled, resolved?.reference.storageKey == key else { return }
            modelError = error.localizedDescription
        }
        loadingModels = false
    }

    private func start() {
        guard canStart, let target = resolved else { return }
        busy = true; startError = nil
        Task {
            defer { busy = false }
            do {
                let request = try DiagnosticSetup.spawnRequest(target: target, model: selectedModel,
                                                               thinking: thinking,
                                                               askingAboutPilot: setup.askingAboutPilot)
                let created = try await app.spawnDiagnostics(request, target: target.reference,
                                                             tracksFeature: setup.tracksFeature)
                dismiss()
                try app.selectSession(created)
            } catch { startError = error.localizedDescription }
        }
    }
}

struct DiagnosticRepairSheet: View {
    let target: DiagnosticRepairTarget
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var diagnostics: SessionDiagnostics?
    @State private var selected: Set<String> = []
    @State private var likelyCause = ""
    @State private var regressionGuidance = ""
    @State private var error: String?
    @State private var busy = false

    private var canStart: Bool {
        !busy && !selected.isEmpty && !likelyCause.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !regressionGuidance.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        SheetScaffold("Start a separate repair agent",
                      subtitle: "Choose the bounded evidence you authorize Pilot to copy into a new Build chat.",
                      primary: SheetPrimaryAction(title: "Start repair agent", key: .commandReturn,
                                                  enabled: canStart, action: startRepair),
                      cancel: { dismiss() }, width: 560, fillsHeight: true) {
            VStack(alignment: .leading, spacing: 16) {
                if let diagnostics {
                    Text("Evidence").font(.pilot(.headline))
                    DiagnosticEvidenceSelectionList(evidence: diagnostics.evidence, selected: $selected)
                    TextField("Likely cause", text: $likelyCause, axis: .vertical).lineLimit(2...4)
                    TextField("Regression-test guidance", text: $regressionGuidance, axis: .vertical).lineLimit(2...4)
                } else if error == nil {
                    ProgressView("Loading bounded local evidence…")
                }
                if let error { Text(error).foregroundStyle(Theme.destructive) }
                Text("Starting a repair does not retry, restart, replay, or otherwise change the diagnosed chat.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            }
        }
        .task { await load() }
    }

    private func load() async {
        guard let targetId = target.specialist.diagnosticTargetId else { return }
        do {
            diagnostics = try await model.hosts.perform(target.reference, kind: .session) { client, _ in
                try await client.diagnostics(targetId, limit: 16)
            }
        } catch { self.error = error.localizedDescription }
    }

    private func startRepair() {
        guard let targetId = target.specialist.diagnosticTargetId else { return }
        busy = true; error = nil
        let request = DiagnosticsHandoffRequest(targetSessionId: targetId,
                                                evidenceRefs: Array(selected).sorted(),
                                                likelyCause: likelyCause,
                                                regressionTestGuidance: regressionGuidance)
        Task {
            defer { busy = false }
            do {
                let handoff = try await model.hosts.perform(target.reference, kind: .session) { client, specialistId in
                    try await client.diagnosticsHandoff(specialistId, request: request)
                }
                let spawn = try DiagnosticRepair.spawnRequest(handoff: handoff, fallbackCwd: target.specialist.cwd)
                let created: HostResourceRef
                if target.reference.host == model.localHost {
                    let session = try await model.client.spawn(spawn)
                    guard let localHost = model.localHost else { throw HostRoutingError.invalidReference }
                    created = HostResourceRef(host: localHost, kind: .session, localId: session.id)
                } else {
                    created = try await model.createHostedSession(spawn, on: target.reference.host)
                }
                dismiss()
                try model.selectSession(created)
            } catch { self.error = error.localizedDescription }
        }
    }
}

private struct DiagnosticEvidenceSelectionList: View {
    let evidence: [DiagnosticEvidence]
    @Binding var selected: Set<String>

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(evidence.prefix(16).enumerated()), id: \.offset) { _, item in
                    DiagnosticEvidenceSelectionRow(evidence: item, selected: $selected)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 190)
    }
}

private struct DiagnosticEvidenceSelectionRow: View {
    let evidence: DiagnosticEvidence
    @Binding var selected: Set<String>

    var body: some View {
        Button(action: toggleSelection) {
            HStack(alignment: .top, spacing: 8) {
                if suspected { PilotSymbol(PilotIcon.warning, context: .inline).foregroundStyle(Theme.warning) }
                VStack(alignment: .leading, spacing: 2) {
                    Text(assessmentLabel ?? evidenceLabel).font(.pilot(.body, weight: .medium))
                        .foregroundStyle(suspected ? Theme.warning : Theme.foreground)
                    Text(detail).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground).lineLimit(2)
                }
                Spacer(minLength: 8)
                if selected.contains(evidence.ref) {
                    PilotSymbol(PilotIcon.done, context: .inline).foregroundStyle(Theme.mutedForeground)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(selected.contains(evidence.ref) ? 1 : 0.72)
        .help("\(evidence.source.rawValue) · \(evidence.at) · \(evidence.ref)")
    }

    private var suspected: Bool { evidence.assessment?.hasPrefix("suspected_") == true }
    private var evidenceLabel: String { evidence.kind == "devbox.setup" ? "Devbox setup" : evidence.kind }

    private var assessmentLabel: String? {
        switch evidence.assessment {
        case "suspected_no_progress": "Tool may be stalled"
        case "suspected_unresponsive": "Worker may be unresponsive"
        case "suspected_cancellation_delay": "Cancellation is taking longer than expected"
        case "waiting_user": "Waiting for your response"
        case "waiting_child": "Waiting for a child agent"
        case "background_work": "Background work is still running"
        case "paused_sleep": "Deferred while the Mac sleeps"
        case "paused_update": "Deferred for an update"
        case "paused_quota": "Deferred by a usage limit"
        case "paused_connectivity": "Deferred while disconnected"
        case "paused_user": "Stopped by you"
        case "cancelling": "Cancellation requested"
        default: nil
        }
    }

    private var detail: String {
        if evidence.kind == "devbox.setup" {
            let stage = evidence.stage.map { $0.replacingOccurrences(of: "_", with: " ").capitalized } ?? "Unknown stage"
            let outcome = evidence.outcome?.capitalized ?? "Unknown outcome"
            let reason = evidence.reason.map { $0.replacingOccurrences(of: "_", with: " ").capitalized }
            return [stage, outcome, reason].compactMap { $0 }.joined(separator: " · ")
        }
        let category = evidence.category.map { $0 == "mcp" ? "MCP" : $0.capitalized }
        var parts = [category, evidence.nested == true ? "Nested call" : nil].compactMap { $0 }
        if let age = evidence.progressAgeMs, evidence.kind == "tool.in_flight" {
            parts.append("Last useful progress \(duration(age)) ago")
        }
        return parts.isEmpty ? evidence.kind : parts.joined(separator: " · ")
    }

    private func duration(_ milliseconds: Double) -> String {
        if milliseconds < 60_000 { return "\(max(1, Int(milliseconds / 1000)))s" }
        return "\(Int(milliseconds / 60_000))m"
    }

    private func toggleSelection() {
        if selected.contains(evidence.ref) {
            selected.remove(evidence.ref)
        } else {
            selected.insert(evidence.ref)
        }
    }
}
