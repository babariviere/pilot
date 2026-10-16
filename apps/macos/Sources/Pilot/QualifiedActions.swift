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

    func createHostedChat(form: NewSessionForm, host: HostRef, project: Project, revision: UUID) async throws {
        guard let origin = localHost else { throw HostRoutingError.invalidReference }
        _ = try hosts.endpoint(host)
        try await finishAdopted(on: host)
        let images = form.attachments.items
        let operation: DurableOperation
        let receipt: OperationReceipt
        if form.pendingOperationId == nil {
            form.pendingOperationId = hosts.pendingOperations.values.first {
                $0.destination == host && ($0.kind == "chat-create" || $0.kind == "chat-create-attached")
            }?.operationId
        }
        if let id = form.pendingOperationId, let pending = hosts.pendingOperations[id] {
            guard pending.destination == host,
                  case let .receipt(known)? = hosts.operationDeliveries[id], known.state != .pending else {
                throw ClientError("Delivery unknown. Your draft has been kept. Reconnect to check before starting another chat.")
            }
            operation = pending; receipt = known
        } else {
            try persistDrafts()
            var staged: [HostedAttachment] = []
            for image in images { staged.append(try await hosts.upload(image, host: host, origin: origin)) }
            let request = form.spawnRequest(in: project, rawAttachments: true)
            let result: (DurableOperation, OperationDelivery)
            if staged.isEmpty {
                result = try await hosts.deliver(host: host, kind: "chat-create", targetId: nil, payload: request, origin: origin)
            } else {
                result = try await hosts.deliverAttached(host: host, kind: "chat-create-attached", targetId: nil,
                    request: request, attachments: staged, origin: origin)
            }
            form.pendingOperationId = result.0.operationId
            try persistDrafts()
            guard case let .receipt(known) = result.1, known.state != .pending else {
                throw ClientError("Delivery unknown. Your draft has been kept. Reconnect to check before starting another chat.")
            }
            operation = result.0; receipt = known
        }
        try await adoptCreatedChat(operation, receipt: receipt, form: form, revision: revision)
    }

    func adoptCreatedChat(_ operation: DurableOperation, receipt: OperationReceipt, form: NewSessionForm, revision: UUID) async throws {
        try receipt.validate(operation)
        let host = operation.destination
        if receipt.state == .accepted {
            let payload = try JSONDecoder().decode(JSONValue.self, from: Data(operation.payload.utf8))
            let request = payload["request"] ?? payload
            let imageIDs = Set((payload["attachments"]?.array ?? []).compactMap { $0["uploadId"]?.string })
            // A late result must not erase a newer draft, even after an app restart.
            if request["message"]?.string == form.message, imageIDs == Set(form.attachments.items.map { $0.id.uuidString }), form.revision == revision {
                _ = form.completeSubmission(revision: revision)
            }
        }
        form.pendingOperationId = nil
        try persistDrafts()
        try await acknowledgeAdopted(operation, receipt: receipt)
        if receipt.state == .rejected { throw ClientError("The chat was not started. Your draft has been kept.") }
        if form.message.isEmpty {
            try selectSession(HostResourceRef(host: host, kind: .session,
                localId: receipt.result?["sessionId"]?.string ?? operation.targetId))
        }
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
        guard let ref = resourceRef(id, kind: kind, context: context) else { return }
        showingArchive = false
        showingInbox = false
        clearProjectSubpage()
        let key = ref.host == localHost ? ref.localId : ref.storageKey
        switch kind {
        case .session: try? selectSession(ref)
        case .project:
            selectedSessionId = nil; selectedMissionId = nil; selectedProjectId = key
            hosts.selection = ref
        case .mission:
            selectedSessionId = nil; selectedProjectId = nil; selectedMissionId = key
            hosts.selection = ref
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
                    ($0.kind == "chat-send" || $0.kind == "chat-send-attached") && !adoptedOperationIds.contains($0.operationId)
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
