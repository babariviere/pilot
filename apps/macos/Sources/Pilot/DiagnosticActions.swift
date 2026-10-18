import Foundation
import PilotCore
import PilotTelemetry
import SwiftUI

struct DiagnosticRepairTarget: Identifiable {
    let specialist: SessionSummary
    let reference: HostResourceRef
    var id: String { reference.storageKey }
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
        let tracksFeature = !askingAboutPilot && !session.isControl
        if tracksFeature { PilotTelemetry.shared.recordFeature(.attempt(.diagnoseChat)) }
        if let context, !context.available {
            if tracksFeature, let event = FeatureEvent.outcome(.diagnoseChat, .unavailable, reason: .disconnected) {
                PilotTelemetry.shared.recordFeature(event)
            }
            sessionActionError = "Reconnect to this devbox before starting diagnostics."
            return
        }
        diagnosingSessions.insert(target.storageKey)
        let request = SpawnRequest(
            message: askingAboutPilot
                ? "Open an Ask about Pilot conversation. Inspect the admitted target using only bounded operational evidence. Briefly explain what you can observe, cite evidence refs for findings, distinguish observations from likely causes, and do not retry, restart, replay, or change the target."
                : "Diagnose the admitted target chat using only bounded operational evidence. Summarize its current state and any useful performance or lifecycle finding, cite evidence refs, distinguish observations from likely causes, and do not retry, restart, replay, or change the target.",
            title: askingAboutPilot ? "Ask about Pilot" : "Diagnose this chat",
            mode: .ask,
            role: .diagnostics,
            diagnosticTargetId: session.id
        )
        Task {
            defer { diagnosingSessions.remove(target.storageKey) }
            var createdSpecialist = false
            do {
                let created: HostResourceRef
                if target.host == localHost {
                    let specialist = try await client.spawn(request)
                    guard let localHost else { throw HostRoutingError.invalidReference }
                    created = HostResourceRef(host: localHost, kind: .session, localId: specialist.id)
                } else {
                    created = try await createHostedSession(request, on: target.host)
                }
                createdSpecialist = true
                if tracksFeature, let event = FeatureEvent.outcome(.diagnoseChat, .success, reason: .none) {
                    PilotTelemetry.shared.recordFeature(event)
                }
                try selectSession(created)
            } catch {
                if tracksFeature, !createdSpecialist {
                    let disconnected = target.host != localHost && !hosts.available.contains(target.host)
                    let event = disconnected
                        ? FeatureEvent.outcome(.diagnoseChat, .unavailable, reason: .disconnected)
                        : FeatureEvent.outcome(.diagnoseChat, .failure, reason: .unknown)
                    if let event { PilotTelemetry.shared.recordFeature(event) }
                }
                sessionActionError = error.localizedDescription
            }
        }
    }

    /// The Help menu diagnoses the control chat on the currently viewed host, falling back to Local.
    func askAboutPilot() {
        if let selected = hosts.selection, selected.host != localHost,
           let control = hosts.sessions.first(where: { $0.ref.host == selected.host && $0.value.isControl }) {
            diagnose(control.value, context: HostViewContext(host: selected.host, hosts: hosts), askingAboutPilot: true)
            return
        }
        guard let control = client.sessions.first(where: \.isControl) else {
            sessionActionError = "Pilot diagnostics are not available until the local daemon is connected."
            return
        }
        diagnose(control, askingAboutPilot: true)
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
