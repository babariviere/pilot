import AppKit
import Foundation
import PilotCore

extension AppModel {
    func acknowledgeAdopted(_ operation: DurableOperation, receipt: OperationReceipt) async throws {
        guard !retiringOperationIds.contains(operation.operationId) else { return }
        retiringOperationIds.insert(operation.operationId)
        defer { retiringOperationIds.remove(operation.operationId) }
        adoptedOperationIds.insert(operation.operationId)
        try persistDrafts()
        try await hosts.acknowledge(operation, receipt: receipt)
        adoptedOperationIds.remove(operation.operationId)
        try persistDrafts()
    }

    private func finishAdopted(on host: HostRef) async throws {
        for id in adoptedOperationIds {
            guard let operation = hosts.pendingOperations[id], operation.destination == host else { continue }
            guard case let .receipt(receipt)? = hosts.operationDeliveries[id], receipt.state != .pending else {
                throw ClientError("A previous message is still being checked. Reconnect before sending another.")
            }
            try await acknowledgeAdopted(operation, receipt: receipt)
        }
    }

    func presentMissionSheet(_ sheet: MissionSheet, context: HostViewContext?) {
        missionSheetContext = context
        missionSheet = sheet
    }

    func attention(on host: HostRef) -> SessionAttention {
        if host == localHost { return attention }
        if let existing = hostAttentionStores[host] { return existing }
        let key = HostResourceRef(host: host, kind: .session, localId: "reviews").storageKey
        let store = SessionAttention(keyPrefix: key + ".")
        store.onReview = { [weak self] mark in
            guard let self else { return }
            Task {
                try? await self.hosts.perform(HostResourceRef(host: host, kind: .session, localId: mark.sessionId), kind: .session) {
                    client, _ in try await client.review(ReviewRequest(marks: [mark]))
                }
            }
        }
        hostAttentionStores[host] = store
        return store
    }

    func isUnread(_ session: SessionSummary, on host: HostRef) -> Bool { attention(on: host).isUnread(session) }

    func review(_ session: SessionSummary, on host: HostRef, chatVisible: Bool) {
        if host == localHost { review(session, chatVisible: chatVisible); return }
        if attention(on: host).review(session, chatVisible: chatVisible, appActive: NSApp.isActive) { didReviewHost() }
    }

    /// The Local composer action uses only the Local client, never a pending remote operation.
    func createLocalChat(_ request: SpawnRequest, form: NewSessionForm, revision: UUID,
                         tracked: TrackedItemBinding? = nil) async throws -> SessionSummary {
        guard form.revision == revision, (form.executionHost ?? localHost) == localHost,
              form.pendingOperationId == nil, pendingChatCreate(on: localHost) == nil else {
            throw HostRoutingError.invalidReference
        }
        let session = try await client.spawn(request)
        if let tracked { await bindTrackedItem(tracked.itemId, label: tracked.label, sessionId: session.id) }
        if (form.executionHost ?? localHost) == localHost, form.completeSubmission(revision: revision) {
            selectedSessionId = session.id
        }
        return session
    }

    /// The Home Check action owns visible progress and recovery. It never creates a fresh intent.
    /// Explicit retry is separately confirmed by the UI and still looks up the original receipt first.
    func checkHostedChat(_ operation: DurableOperation, form: NewSessionForm, retryOriginal: Bool = false,
                         openConfirmed: Bool = false, attempts: Int = 3,
                         delay: Duration = .milliseconds(500)) async {
        let revision = form.revision
        guard !form.checkingStart, !form.busy,
              ownsChatStart(operation, form: form, revision: revision) else { return }
        let checkId = UUID()
        form.startCheckId = checkId
        form.checkingStart = true
        form.error = nil
        form.startRecoveryMessage = nil
        defer {
            if form.startCheckId == checkId { form.startCheckId = nil; form.checkingStart = false }
        }
        do {
            guard operation.kind == "chat-create" || operation.kind == "chat-create-attached",
                  form.pendingOperationId == nil || form.pendingOperationId == operation.operationId else {
                throw HostRoutingError.invalidReference
            }
            form.pendingOperationId = operation.operationId
            try persistDrafts()
            if retryOriginal { try await hosts.retryOperation(operation) }
            guard ownsChatStart(operation, form: form, revision: revision), form.startCheckId == checkId else { return }
            let delivery = try await hosts.checkOperation(operation, attempts: attempts, delay: delay)
            guard ownsChatStart(operation, form: form, revision: revision), form.startCheckId == checkId else { return }
            switch delivery {
            case let .receipt(receipt) where receipt.state != .pending:
                try await adoptCreatedChat(operation, receipt: receipt, form: form, revision: revision,
                                           openWhenDraftChanged: openConfirmed)
            case .receipt:
                form.startRecoveryMessage = "The devbox has the request, but chat start is still unconfirmed. Check again shortly. Your draft is kept."
            case .unknown:
                form.startRecoveryMessage = "No receipt was found on the original devbox. This does not prove the chat failed. Check again, or retry only the saved original start."
            }
        } catch {
            guard ownsChatStart(operation, form: form, revision: revision), form.startCheckId == checkId else { return }
            if case let .receipt(receipt)? = hosts.operationDeliveries[operation.operationId], receipt.state == .accepted {
                form.error = "Chat start was confirmed, but the existing chat could not be opened: \(error.localizedDescription) Reconnect and choose Open chat. Do not resend. Your draft is kept."
            } else {
                form.error = hosts.pendingOperations[operation.operationId] == nil ? error.localizedDescription
                    : "Could not confirm chat start: \(error.localizedDescription) Your draft is kept. Reconnect to the original devbox and Check again."
            }
        }
    }

    /// A deterministic, draft-free create. The outbox reuses the exact intent after an uncertain delivery.
    func createHostedSession(_ request: SpawnRequest, on host: HostRef) async throws -> HostResourceRef {
        guard let origin = localHost else { throw HostRoutingError.invalidReference }
        _ = try hosts.endpoint(host)
        let kind = request.role == .diagnostics ? "diagnostics-create" : "repair-create"
        let (operation, delivery) = try await hosts.deliver(host: host, kind: kind, targetId: nil,
                                                            payload: request, origin: origin)
        guard case let .receipt(receipt) = delivery, receipt.state != .pending else {
            throw ClientError("Delivery is still being checked. Reconnect, then choose the action again.")
        }
        try receipt.validate(operation)
        try await acknowledgeAdopted(operation, receipt: receipt)
        guard receipt.state == .accepted else { throw ClientError("The chat was not started.") }
        return HostResourceRef(host: host, kind: .session,
                               localId: receipt.result?["sessionId"]?.string ?? operation.targetId)
    }

    func adoptCreatedChat(_ operation: DurableOperation, receipt: OperationReceipt, form: NewSessionForm, revision: UUID,
                          openWhenDraftChanged: Bool = false) async throws {
        try receipt.validate(operation)
        guard ownsChatStart(operation, form: form, revision: revision) else { return }
        guard receipt.state != .pending else { throw ClientError("Chat start is still unconfirmed. Check again shortly.") }
        let host = operation.destination
        if receipt.state == .accepted {
            guard receipt.result?["sessionId"]?.string == nil || receipt.result?["sessionId"]?.string == operation.targetId else {
                throw HostRoutingError.identityChanged
            }
            try await hosts.createdSession(operation)
            guard ownsChatStart(operation, form: form, revision: revision) else { return }
            let payload = try JSONDecoder().decode(JSONValue.self, from: Data(operation.payload.utf8))
            let request = payload["request"] ?? payload
            let imageIDs = Set((payload["attachments"]?.array ?? []).compactMap { $0["uploadId"]?.string })
            let project = hosts.presentationClient(host).project(request["projectId"]?.string)
            let current = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(form.spawnRequest(in: project, rawAttachments: true)))
            // A late result must not erase a newer draft, even after an app restart.
            let matches = request == current && imageIDs == Set(form.attachments.items.map { $0.id.uuidString })
                && form.revision == revision && (form.executionHost ?? localHost) == host
                && (draftProjectId == nil || draftProjectId == request["projectId"]?.string)
            guard matches || openWhenDraftChanged else {
                form.startRecoveryMessage = "Chat started. Your newer draft is kept. Open the existing chat to view its result."
                return
            }
            if matches { _ = form.completeSubmission(revision: revision) }
            // Persist navigation before retiring the outbox, so a crash cannot lose the result.
            try selectSession(HostResourceRef(host: host, kind: .session, localId: operation.targetId))
        }
        form.pendingOperationId = nil
        form.error = nil
        form.startRecoveryMessage = nil
        try persistDrafts()
        try await acknowledgeAdopted(operation, receipt: receipt)
        if receipt.state == .rejected {
            throw ClientError("The devbox rejected the chat start: \(receipt.reason ?? "request not accepted"). Your draft has been kept. You can edit it and start again.")
        }
    }

    private func ownsChatStart(_ operation: DurableOperation, form: NewSessionForm, revision: UUID) -> Bool {
        form.revision == revision && (form.executionHost ?? localHost) == operation.destination
            && (form.pendingOperationId == nil || form.pendingOperationId == operation.operationId)
    }

    func resourceRef(_ id: String, kind: HostResourceKind, context: HostViewContext? = nil) -> HostResourceRef? {
        if id.hasPrefix("hostref1:") {
            guard let ref = try? HostResourceRef.decodeKey(id), ref.kind == kind else { return nil }
            return ref
        }
        guard let host = context?.host ?? localHost else { return nil }
        return HostResourceRef(host: host, kind: kind, localId: id)
    }

    func navigate(_ kind: HostResourceKind, id: String, context: HostViewContext? = nil) {
        beginNavigation()
        defer { endNavigation() }
        guard let ref = resourceRef(id, kind: kind, context: context) else { return }
        showingArchive = false
        showingUsage = false; showingInbox = false
        clearProjectSubpage()
        let key = ref.host == localHost ? ref.localId : ref.storageKey
        switch kind {
        case .session: try? selectSession(ref)
        case .project:
            selectedSessionId = nil; selectedMissionId = nil; selectedProjectId = key
            hosts.selection = ref
        case .mission:
            openMission(ref.storageKey)
        default: return
        }
    }

    func deliverMessage(_ ref: HostResourceRef, text: String, mode: DeliveryMode,
                        composer: ComposerState?, includeImages: Bool = true) async throws {
        guard let origin = localHost, ref.kind == .session else { throw HostRoutingError.invalidReference }
        guard composer?.delivering != true else { return }
        _ = try hosts.endpoint(ref, kind: .session)
        try await finishAdopted(on: ref.host)
        composer?.delivering = true
        defer { composer?.delivering = false }
        let savedText = composer?.draft
        let images = includeImages ? composer?.attachments.items ?? [] : []
        let pending = composer?.pendingOperationId.flatMap { hosts.pendingOperations[$0] }
            ?? hosts.pendingOperations.values.first {
                $0.destination == ref.host && $0.targetId == ref.localId &&
                    ($0.kind == "chat-send" || $0.kind == "chat-send-attached") &&
                    !adoptedOperationIds.contains($0.operationId) && !ownsDiagnosticRepairOperation($0)
            }
        if let known = pending {
            let id = known.operationId
            guard case let .receipt(receipt)? = hosts.operationDeliveries[id], receipt.state != .pending else {
                throw ClientError("Delivery is not yet confirmed. Reconnect and check before sending another message.")
            }
            let payload = try JSONDecoder().decode(JSONValue.self, from: Data(known.payload.utf8))
            let request = payload["request"] ?? payload
            let original = request["message"]?.string
            let originalIDs = Set((payload["attachments"]?.array ?? []).compactMap { $0["uploadId"]?.string })
            try await adoptMessage(known, receipt: receipt, composer: composer, text: original,
                images: images.filter { originalIDs.contains($0.id.uuidString) })
            return
        }
        try persistDrafts()
        var staged: [HostedAttachment] = []
        for image in images { staged.append(try await hosts.upload(image, host: ref.host, origin: origin)) }
        struct Request: Codable, Sendable { let message: String; let mode: DeliveryMode }
        let request = Request(message: text, mode: mode)
        let result: (DurableOperation, OperationDelivery)
        if staged.isEmpty {
            result = try await hosts.deliver(host: ref.host, kind: "chat-send", targetId: ref.localId, payload: request, origin: origin)
        } else {
            result = try await hosts.deliverAttached(host: ref.host, kind: "chat-send-attached", targetId: ref.localId,
                request: request, attachments: staged, origin: origin)
        }
        composer?.pendingOperationId = result.0.operationId
        try persistDrafts()
        guard case let .receipt(receipt) = result.1, receipt.state != .pending else {
            throw ClientError("Delivery unknown. Your draft has been kept. Reconnect to check it before retrying.")
        }
        try await adoptMessage(result.0, receipt: receipt, composer: composer, text: savedText, images: images)
    }

    func adoptPendingMessage(_ operation: DurableOperation, composer: ComposerState) async throws {
        guard operation.kind == "chat-send" || operation.kind == "chat-send-attached",
              case let .receipt(receipt)? = hosts.operationDeliveries[operation.operationId], receipt.state != .pending else {
            throw ClientError("Delivery is not yet confirmed.")
        }
        let payload = try JSONDecoder().decode(JSONValue.self, from: Data(operation.payload.utf8))
        let request = payload["request"] ?? payload
        let ids = Set((payload["attachments"]?.array ?? []).compactMap { $0["uploadId"]?.string })
        try await adoptMessage(operation, receipt: receipt, composer: composer, text: request["message"]?.string,
            images: composer.attachments.items.filter { ids.contains($0.id.uuidString) })
    }

    private func adoptMessage(_ operation: DurableOperation, receipt: OperationReceipt, composer: ComposerState?,
                              text: String?, images: [PastedImage]) async throws {
        try receipt.validate(operation)
        if receipt.state == .accepted, let composer {
            if composer.draft.trimmingCharacters(in: .whitespacesAndNewlines) == text?.trimmingCharacters(in: .whitespacesAndNewlines) { composer.draft = "" }
            let submitted = Set(images.map(\.id))
            composer.attachments.items.removeAll { submitted.contains($0.id) }
        }
        composer?.pendingOperationId = nil
        try persistDrafts()
        try await acknowledgeAdopted(operation, receipt: receipt)
        if receipt.state == .rejected { throw ClientError("The message was not sent. Your draft has been kept.") }
    }
}
