import Combine
import Foundation
import PilotCore
import SwiftUI

@MainActor
final class SharedTaskPlacementModel: ObservableObject {
    let service: any SharedProjectService
    let missionId: String
    let taskId: String
    let content: SharedProjectModel
    @Published private(set) var models: [ModelOption] = []
    @Published private(set) var grant: DelegationGrant?
    @Published private(set) var busy = false
    @Published private(set) var uncertainStart = false
    @Published private(set) var stopRequested = false
    @Published private(set) var releaseConfirmedAtTarget = false
    @Published private(set) var error: String?
    @Published private(set) var lastHomeEpoch: Int?
    @Published private(set) var intentLoaded = false
    @Published private(set) var allocationReady = false
    @Published var selectedModel = ""
    @Published var instructions = ""
    @Published var onlineURLs = Set<String>()
    @Published var requirements: [String: SharedContextReference.Requirement] = [:]
    @Published var confirmed = false
    private var contentChanges: AnyCancellable?
    private var pendingIntent: SharedPlacementIntent?
    private var intentKey: SharedPlacementIntentKey {
        SharedPlacementIntentKey(authority: service.binding.missionHome, missionId: missionId, taskId: taskId)
    }

    init(service: any SharedProjectService, missionId: String, taskId: String) {
        self.service = service; self.missionId = missionId; self.taskId = taskId
        content = SharedProjectModel(service: service)
        contentChanges = content.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
    }
    var task: MissionTask? { content.mission?.snapshot.detail.tasks.first { $0.id == taskId } }
    var artifacts: [MissionArtifactLink] { content.mission?.snapshot.detail.artifacts.filter { $0.taskId == taskId } ?? [] }
    var resources: [MissionResource] { content.mission?.snapshot.detail.resources.filter { $0.taskId == taskId } ?? [] }
    static func artifactKey(_ artifact: MissionArtifactLink) -> String {
        // Artifact IDs alone are not installation/session-qualified identity.
        let data = try! JSONEncoder().encode([artifact.sessionId, artifact.artifactId])
        return data.base64EncodedString()
    }
    var definitionRevision: Int? {
        guard let version = content.version(kind: .task, id: taskId), !version.deleted else { return nil }
        return version.definitionRevision
    }
    var occupied: Bool { uncertainStart || grant.map { $0.state != .sealed } == true }
    var canStart: Bool {
        !busy && intentLoaded && allocationReady && lastHomeEpoch != nil && !occupied && confirmed && content.versionsReady && content.mission?.source == .canonical
            && definitionRevision.map { $0 > 0 } == true && task?.sessionId == nil && task?.status.canStart == true
            && content.mission?.snapshot.detail.mission.status == .active
            && models.contains(where: { $0.id == selectedModel }) && instructions.utf16.count <= 8000
            && artifacts.count <= 40
            && artifacts.allSatisfy { $0.revision.map { $0 > 0 } == true && requirements[Self.artifactKey($0)] != nil }
            && resources.allSatisfy { onlineURLs.contains($0.url) && $0.url.utf16.count <= 2048 }
    }

    func load() async {
        guard !busy else { return }
        busy = true; error = nil; confirmed = false
        defer { busy = false }
        do {
            try await lookup()
            if occupied { return }
            await content.loadMission(missionId)
            guard content.versionsReady else { throw HostRoutingError.staleGeneration }
            let list = try await service.targetModels()
            try Task.checkCancellation()
            models = list.models.filter { option in
                guard task?.preferredModelSetBy == "user", let preferred = task?.preferredModel else { return true }
                return option.id == preferred
            }
            if !models.contains(where: { $0.id == selectedModel }) { selectedModel = "" }
        } catch {
            if !(error is CancellationError) { self.error = "Task placement is unavailable. Reconnect and refresh the saved task and target models." }
        }
    }

    /// Only a read of the existing home allocation can resolve a lost start reply.
    /// Absence is not permission to issue another request while the first may still arrive.
    func checkStatus() async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do { try await lookup() }
        catch { self.error = "Disconnected. This task may still be running on its selected devbox." }
    }
    private func lookup() async throws {
        allocationReady = false
        pendingIntent = try await service.placementIntents.pending(for: intentKey)
        uncertainStart = pendingIntent != nil; intentLoaded = true
        let allocations = try await service.taskAllocations(missionId: missionId, taskId: taskId)
        var seen = Set<String>()
        // The home inventory lists its allocation before any same-host target view.
        // Keep that first entry, never a later target-side sealed duplicate.
        let matches = allocations.filter { seen.insert($0.delegationId).inserted }
            .sorted { $0.executionEpoch > $1.executionEpoch }
        guard matches.filter({ $0.state != .sealed }).count <= 1 else { throw HostRoutingError.invalidReference }
        let epoch = matches.first?.executionEpoch ?? 0
        guard epoch >= (lastHomeEpoch ?? 0), epoch < 9_007_199_254_740_991 else { throw HostRoutingError.staleGeneration }
        lastHomeEpoch = epoch
        if let latest = matches.first {
            guard latest.task.mission.home == service.binding.missionHome, latest.task.mission.missionId == missionId,
                  latest.task.taskId == taskId, latest.executionEpoch > 0 else { throw HostRoutingError.identityChanged }
            if latest.bindingId == service.binding.bindingId { try validate(latest) }
            if let grant, latest.executionEpoch < grant.executionEpoch { throw HostRoutingError.staleGeneration }
            grant = latest
            stopRequested = latest.state == .cancelRequested
        }
        // An unchanged sealed predecessor does not settle a possibly delayed POST.
        // A newer home epoch fences that old intent, even if the newer work has sealed.
        if let pendingIntent, epoch > pendingIntent.previousEpoch { try await clearPending(pendingIntent) }
        allocationReady = true
    }
    private func clearPending(_ intent: SharedPlacementIntent) async throws {
        try await service.placementIntents.clear(intent)
        pendingIntent = nil; uncertainStart = false
    }
    private func validate(_ grant: DelegationGrant) throws {
        guard grant.bindingId == service.binding.bindingId, grant.bindingGeneration == service.binding.generation,
              grant.task.mission.home == service.binding.missionHome, grant.task.mission.missionId == missionId,
              grant.task.taskId == taskId, grant.target == service.binding.executionProject,
              grant.session.host == service.binding.executionProject.host else { throw HostRoutingError.identityChanged }
    }
    func start() async {
        guard canStart, let revision = definitionRevision, let previousEpoch = lastHomeEpoch else { return }
        let references = artifacts.compactMap { artifact -> SharedPlacementRequest.Reference? in
            guard let revision = artifact.revision, let requirement = requirements[Self.artifactKey(artifact)] else { return nil }
            return SharedPlacementRequest.Reference(host: service.binding.missionHome, sessionId: artifact.sessionId,
                                                     artifactId: artifact.artifactId, revision: revision, requirement: requirement)
        }
        let request = SharedPlacementRequest(bindingId: service.binding.bindingId, expectedRevision: revision,
            expectedPreviousEpoch: previousEpoch,
            model: selectedModel, references: references, onlineOnlyUrls: onlineURLs.sorted(),
            message: instructions.isEmpty ? nil : instructions)
        busy = true; error = nil
        defer { busy = false; confirmed = false }
        let intent = SharedPlacementIntent(key: intentKey, bindingId: service.binding.bindingId,
                                           bindingGeneration: service.binding.generation, previousEpoch: previousEpoch)
        do {
            // Persist uncertainty before any network write. Reopening can only read the
            // existing allocation; this marker contains no request to replay.
            try await service.placementIntents.begin(intent)
            pendingIntent = intent; uncertainStart = true
            let value = try await service.reserve(missionId: missionId, taskId: taskId, request: request)
            try validate(value)
            guard value.executionEpoch == previousEpoch + 1 else { throw HostRoutingError.identityChanged }
            grant = value
            try await clearPending(intent)
        } catch {
            // No second POST, even on a connection-generation change or timeout.
            if let status = (error as? ClientError)?.status, [400, 404, 409, 413, 422].contains(status) {
                try? await clearPending(intent)
            }
            try? await lookup()
            self.error = occupied ? "The start was not confirmed. Check the existing task before taking any other action."
                : "This task changed. Refresh and review it before starting."
        }
    }
    func requestStop() async {
        guard !busy, let grant, grant.state != .sealed, !stopRequested else { return }
        busy = true; error = nil; stopRequested = true
        defer { busy = false }
        do {
            let value = try await service.cancel(grant)
            try validate(value)
            guard value.delegationId == grant.delegationId, value.executionEpoch == grant.executionEpoch else {
                throw HostRoutingError.identityChanged
            }
            self.grant = value
        } catch { self.error = "Stop requested, but not confirmed. The task stays on its selected devbox until it confirms release." }
    }
    func confirmStopped() async {
        guard !busy, stopRequested, let grant, grant.state != .sealed else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let result = try await service.confirmStopped(grant)
            if result.sealed {
                releaseConfirmedAtTarget = true
                // A target response alone does not free the mission-home allocation.
                try? await lookup()
            } else { error = "This devbox is still finishing work. Check again after its agents, jobs and terminals stop." }
        } catch { self.error = "Release was not confirmed. Reconnect and check again. The task has not moved." }
    }
}

/// Embedded in existing task forms. A target is an enrolled project, never an arbitrary
/// host picker or a fallback destination chosen because another host is disconnected.
struct SharedTaskPlacementFields: View {
    let mission: HostResourceRef
    let task: MissionTask
    @ObservedObject var hosts: HostClients
    var onStarted: (HostResourceRef) -> Void = { _ in }
    @State private var bindings: [SharedContextBinding] = []
    @State private var selectedId = ""
    @State private var error: String?
    @State private var occupiedBindingId: String?
    @State private var uncertainStart = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let error { InlineProblem(error) { Task { await load() } } }
            if !bindings.isEmpty {
                Picker("Run on", selection: $selectedId) {
                    Text("Choose a linked project").tag("")
                    ForEach(bindings, id: \.bindingId) { binding in
                        let context = SharedProjectContext(binding: binding, readingHost: mission.host, hosts: hosts)
                        Text("\(context.name(binding.executionProject.host)) · \(binding.executionProject.projectId)").tag(binding.bindingId)
                    }
                }
                .disabled(occupiedBindingId != nil || uncertainStart)
                if let binding = bindings.first(where: { $0.bindingId == selectedId }) {
                    let context = SharedProjectContext(binding: binding, readingHost: mission.host, hosts: hosts)
                    SharedPlacementContent(context: context, missionId: mission.localId, taskId: task.id, revision: hosts.sharedRevision, onStarted: onStarted,
                        onAllocationChanged: { Task { await load() } }, onUncertainChanged: { uncertainStart = $0 })
                        .id(SharedProjectScope(binding: binding, host: mission.host))
                } else if occupiedBindingId != nil {
                    Text("This task remains on its previous devbox until that devbox confirms release.")
                        .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                }
            } else if error == nil {
                Text("Link a project and select this mission in project sharing settings to run this task on another devbox.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            }
        }.font(.pilot(.body)).foregroundStyle(Theme.foreground)
        .task(id: [mission.storageKey, String(hosts.sharedRevision), String(hosts.available.contains(mission.host))]) {
            if !bindings.isEmpty { try? await Task.sleep(for: .milliseconds(200)) }
            guard !Task.isCancelled else { return }
            await load()
        }
    }
    private func load() async {
        do {
            guard mission.kind == .mission else { throw HostRoutingError.invalidReference }
            let summaries = try await hosts.sharedContexts(on: mission.host)
            guard !Task.isCancelled else { return }
            bindings = summaries.map(\.binding).filter {
                $0.state == .active && $0.missionHome.matches(mission.host) && $0.missionIds.contains(mission.localId)
            }
            let active = summaries.flatMap(\.grants).filter {
                $0.task.mission.home.matches(mission.host) && $0.task.mission.missionId == mission.localId
                    && $0.task.taskId == task.id && $0.state != .sealed
            }
            guard active.count <= 1 else { throw HostRoutingError.invalidReference }
            occupiedBindingId = active.first?.bindingId
            if let occupiedBindingId { selectedId = occupiedBindingId }
            // Do not preselect a target or infer one from a repository name.
            if !bindings.contains(where: { $0.bindingId == selectedId }) { selectedId = "" }
            error = nil
        } catch { self.error = "Task placement is unavailable. Reconnect to the computer that saves this mission." }
    }
}

private struct SharedPlacementContent: View {
    let context: SharedProjectContext
    let revision: Int
    let onStarted: (HostResourceRef) -> Void
    let onAllocationChanged: () -> Void
    let onUncertainChanged: (Bool) -> Void
    @StateObject private var model: SharedTaskPlacementModel
    private var content: SharedProjectModel { model.content }

    init(context: SharedProjectContext, missionId: String, taskId: String, revision: Int, onStarted: @escaping (HostResourceRef) -> Void,
         onAllocationChanged: @escaping () -> Void, onUncertainChanged: @escaping (Bool) -> Void) {
        self.context = context; self.onStarted = onStarted
        self.revision = revision
        self.onAllocationChanged = onAllocationChanged; self.onUncertainChanged = onUncertainChanged
        _model = StateObject(wrappedValue: SharedTaskPlacementModel(service: context, missionId: missionId, taskId: taskId))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Work runs on \(context.name(context.binding.executionProject.host)) · Notes are saved on \(context.name(context.binding.memoryHome.host)) · Missions are saved on \(context.name(context.binding.missionHome))")
                .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
            if let error = model.error ?? content.error { InlineProblem(error) { Task { await model.checkStatus() } } }
            if let grant = model.grant, grant.state != .sealed {
                Text(model.stopRequested ? "Stop requested" : grant.state == .reserved ? "Waiting for the selected devbox" : "Running on the selected devbox")
                Text("The task stays here until this devbox confirms it is released, even while disconnected.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                if model.releaseConfirmedAtTarget {
                    Text("The computer confirmed it stopped. Waiting for \(context.name(context.binding.missionHome)) to confirm release.")
                        .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                }
                HStack {
                    Button("Check status") { Task { await model.checkStatus() } }
                    Button("Request stop") { Task { await model.requestStop() } }.disabled(model.stopRequested)
                    if model.stopRequested {
                        Button("Confirm stopped") { Task { await model.confirmStopped() } }.disabled(model.releaseConfirmedAtTarget)
                    }
                    if grant.state == .accepted, let host = try? context.host(for: grant.session.host) {
                        Button("Open chat") { onStarted(HostResourceRef(host: host, kind: .session, localId: grant.session.sessionId)) }
                    }
                }.disabled(model.busy)
            } else if model.uncertainStart {
                Text("Start not confirmed. A task may already be starting on the selected devbox.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                Button("Check existing task") { Task { await model.checkStatus() } }.disabled(model.busy)
            } else {
                if model.grant?.state == .sealed {
                    Text("The previous devbox confirmed release.").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                }
                Picker("Target model", selection: $model.selectedModel) {
                    Text("Choose an available model").tag("")
                    ForEach(model.models) { Text($0.name).tag($0.id) }
                }
                if model.models.isEmpty, !model.busy {
                    Text("No available target models. Configure access on that devbox, then refresh.")
                        .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                }
                if model.definitionRevision == nil, !model.busy {
                    Text("The current task version is unavailable. Starting is disabled until it can be read.")
                        .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                }
                TextField("Optional instructions", text: $model.instructions, axis: .vertical).lineLimit(3...6)
                    .onChange(of: model.instructions) { _, _ in model.confirmed = false }
                ForEach(model.artifacts, id: \.id) { artifact in
                    let key = SharedTaskPlacementModel.artifactKey(artifact)
                    Picker(artifact.title, selection: Binding(get: { model.requirements[key]?.rawValue ?? "" }, set: {
                        model.requirements[key] = SharedContextReference.Requirement(rawValue: $0); model.confirmed = false
                    })) {
                        Text("How is this file used?").tag("")
                        Text("Required offline").tag(SharedContextReference.Requirement.required.rawValue)
                        Text("Optional, online only").tag(SharedContextReference.Requirement.optionalOnline.rawValue)
                    }
                    if artifact.revision == nil {
                        Text("Choose a fixed file version in the mission before starting.").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    }
                }
                ForEach(model.resources, id: \.id) { resource in
                    Toggle("\(resource.displayTitle) is online only, not required offline", isOn: Binding(
                        get: { model.onlineURLs.contains(resource.url) }, set: {
                            if $0 { model.onlineURLs.insert(resource.url) } else { model.onlineURLs.remove(resource.url) }
                            model.confirmed = false
                        }))
                    .font(.pilot(.caption))
                }
                Text("Save essential linked content as a mission file with a fixed version before starting. This computer uses its own project files, sign-ins and access approvals.")
                    .font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                Toggle("I confirm this devbox, saved task and reference availability", isOn: $model.confirmed)
                HStack {
                    Button("Refresh task and models") { Task { await model.load() } }.disabled(model.busy)
                    Spacer()
                    Button("Start on \(context.name(context.binding.executionProject.host))") { Task { await model.start() } }
                        .disabled(!model.canStart)
                }
            }
        }
        .task(id: revision) {
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled else { return }
            await model.load()
        }
        .onChange(of: model.selectedModel) { _, _ in model.confirmed = false }
        .onChange(of: model.grant?.state) { _, _ in onAllocationChanged() }
        .onChange(of: model.uncertainStart) { _, value in onUncertainChanged(value) }
        .onDisappear { content.stop() }
    }
}
