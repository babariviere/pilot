import CryptoKit
import Foundation
import PilotCore

/// One generation-bound pass. Durable cursors, queues, authority and publication live on the
/// daemons. Losing this object can only repeat reads/exact acknowledgments, never allocate work.
@MainActor final class ControlCourierPass {
    enum Phase { case operations, events, status, reads }
    let binding: ControlHomeEnrollment
    let home: ControlCourierAPI
    let target: ControlCourierAPI
    let lane: ControlOperationExchangeResponse.Lane
    private var phases: [Phase]
    private var operationCursor: String?
    private var readCursor: String?
    private var freshStatus = false

    func request(_ work: [Phase]) { for phase in work where !phases.contains(phase) { phases.append(phase) } }

    init(binding: ControlHomeEnrollment, home: ControlCourierAPI, target: ControlCourierAPI,
         lane: ControlOperationExchangeResponse.Lane) throws {
        guard binding.schemaVersion == 1, binding.generation > 0, binding.generation <= UInt64(ControlCourierAPI.maximumCounter),
              binding.home != binding.executor,
              binding.home.matches(home.token.host), binding.executor.matches(target.token.host),
              home.token.host != target.token.host else { throw HostRoutingError.identityChanged }
        self.binding = binding; self.home = home; self.target = target; self.lane = lane
        phases = lane == .revocation ? (binding.state == .active ? [.operations] : [])
            : (binding.state == .active ? [.operations, .events, .status, .reads] : [.events, .status, .reads])
    }

    func step(_ fence: ControlCourierScheduler.Fence) async throws -> Bool {
        try fence.check()
        guard !phases.isEmpty else { return false }
        let phase = phases.removeFirst()
        let more: Bool
        switch phase {
        case .operations: more = try await operations(fence)
        case .events: more = try await events(fence)
        case .status:
            do { more = try await status(fence) }
            catch {
                if let failure = error as? ControlCourierFailure,
                   [.snapshotRestartRequired, .snapshotCASMismatch, .staleSnapshot].contains(failure.code) { freshStatus = true }
                throw error
            }
        case .reads: more = try await reads(fence)
        }
        try fence.check()
        if more { phases.append(phase) }
        return !phases.isEmpty
    }

    private func operations(_ fence: ControlCourierScheduler.Fence) async throws -> Bool {
        let page: ControlOperationExchangeResponse = try await home.post(binding.bindingId, ["exchange"],
            ControlOperationExchangeRequest(peer: binding.executor, cursor: operationCursor, lane: lane),
            scope: .exchange, maximumBytes: 2 * 1024 * 1024)
        try fence.check()
        guard page.bindingId == binding.bindingId, page.generation == binding.generation,
              page.lane == lane, page.operations.count <= 16, page.more == (page.next != nil),
              validCursor(page.next), page.next == nil || page.next != operationCursor else { throw HostRoutingError.invalidReference }
        for operation in page.operations {
            try fence.check()
            guard operation.schemaVersion == 1, operation.bindingId == binding.bindingId,
                  operation.bindingGeneration == binding.generation, operation.origin == binding.home,
                  operation.destination == binding.executor, operation.sequence > 0, operation.sequence <= ControlCourierAPI.maximumCounter,
                  !operation.operationId.isEmpty, !operation.producerId.isEmpty, !operation.targetId.isEmpty,
                  operation.targetId.count <= 500, operation.payload.utf8.count <= 64 * 1024,
                  SHA256.hash(data: Data(operation.payload.utf8)).map({ String(format: "%02x", $0) }).joined() == operation.payloadHash else {
                throw HostRoutingError.identityChanged
            }
            // Home owns lane classification and its scheduling barriers. Never reinterpret the
            // executable payload, grant or ceiling in a second client-side dispatcher.
            var delivery = try await target.operation(operation, lookup: true)
            try fence.check()
            if case .unknown = delivery {
                delivery = try await target.operation(operation, lookup: false)
                try fence.check()
            }
            guard case let .receipt(receipt) = delivery, receipt.state != .pending else {
                // Leave this lane's original head/cursor owned by home. Facts/other hosts still run.
                return false
            }
            let adoption: ControlReceiptAdoptionResponse = try await home.post(binding.bindingId, ["ack"],
                ControlOperationAcknowledgment(operation: operation, receipt: receipt), scope: .receipts)
            try fence.check()
            guard adoption.operationId == operation.operationId, adoption.state.rawValue == receipt.state.rawValue else {
                throw HostRoutingError.identityChanged
            }
        }
        operationCursor = page.next
        return page.more
    }

    private func checkpoint() async throws -> ControlHostSyncState {
        let state: ControlHostSyncState = try await home.get(binding.bindingId, ["sync-state"])
        guard state.bindingId == binding.bindingId, state.generation == binding.generation,
              state.host == binding.home, state.events.sourceHost == binding.executor,
              !state.reconciliationRequired, (0...ControlCourierAPI.maximumCounter).contains(state.events.importedThrough) else {
            throw ControlCourierFailure(.reconciliationRequired)
        }
        return state
    }

    private func events(_ fence: ControlCourierScheduler.Fence) async throws -> Bool {
        let state = try await checkpoint()
        try fence.check()
        let cursor = state.events
        guard (cursor.importedThrough == 0) == (cursor.lastEventId == nil) else { throw HostRoutingError.invalidReference }
        let acknowledgment = try ControlCourierAPI.value(ControlRemoteEventAcknowledgment.self, [
            "bindingId": .string(binding.bindingId), "generation": .number(Double(binding.generation)),
            "sourceHost": try json(binding.executor), "through": .number(Double(cursor.importedThrough)),
            "eventId": cursor.lastEventId.map(JSONValue.string) ?? .null,
        ])
        let retained: ControlRemoteEventAcknowledgment = try await target.post(binding.bindingId, ["events", "ack"], acknowledgment, scope: .events)
        try fence.check()
        guard retained == acknowledgment else { throw ControlCourierFailure(.reconciliationRequired) }
        let page: ControlRemoteEventPage = try await target.get(binding.bindingId, ["events"], scope: .events,
            query: [URLQueryItem(name: "after", value: String(cursor.importedThrough)), URLQueryItem(name: "limit", value: "128")], maximumBytes: 1024 * 1024)
        try fence.check()
        guard page.bindingId == binding.bindingId, page.generation == binding.generation,
              page.sourceHost == binding.executor, page.after == cursor.importedThrough,
              page.head >= page.after, page.head <= ControlCourierAPI.maximumCounter,
              page.acknowledgedThrough >= 0, page.acknowledgedThrough <= cursor.importedThrough,
              page.events.count <= 128 else { throw ControlCourierFailure(.reconciliationRequired) }
        var through = page.after, last = cursor.lastEventId
        for event in page.events {
            guard through < ControlCourierAPI.maximumCounter, event.cursor == through + 1, event.sourceHost == binding.executor,
                  !event.eventId.isEmpty, try JSONEncoder().encode(event).count <= 16 * 1024 else {
                throw ControlCourierFailure(.reconciliationRequired)
            }
            through = event.cursor; last = event.eventId
        }
        guard through <= page.head, page.next == (through < page.head ? through : nil),
              !page.events.isEmpty || page.next == nil else { throw ControlCourierFailure(.reconciliationRequired) }
        let imported: ControlRemoteEventAcknowledgment = try await home.post(binding.bindingId, ["events", "import"], page, scope: .events)
        try fence.check()
        guard imported.bindingId == binding.bindingId, imported.generation == binding.generation,
              imported.sourceHost == binding.executor, imported.through == through, imported.eventId == last else {
            throw ControlCourierFailure(.reconciliationRequired)
        }
        let accepted: ControlRemoteEventAcknowledgment = try await target.post(binding.bindingId, ["events", "ack"], imported, scope: .events)
        try fence.check()
        guard accepted == imported else { throw ControlCourierFailure(.reconciliationRequired) }
        return page.next != nil
    }

    private func status(_ fence: ControlCourierScheduler.Fence) async throws -> Bool {
        let state = try await checkpoint()
        try fence.check()
        let cursor = !freshStatus && state.status?.state == .staged ? state.status?.next : nil
        guard validCursor(cursor) else { throw HostRoutingError.invalidReference }
        let page: ControlRemoteStatusPage = try await target.get(binding.bindingId, ["status"], scope: .status,
            query: cursor.map { [URLQueryItem(name: "cursor", value: $0)] } ?? [])
        try fence.check()
        guard page.bindingId == binding.bindingId, page.generation == binding.generation,
              page.snapshot.sourceHost == binding.executor, page.snapshot.revision > 0,
              page.snapshot.revision <= ControlCourierAPI.maximumCounter,
              !page.snapshot.snapshotId.isEmpty, validCursor(page.next), page.next == nil || page.next != cursor,
              try JSONEncoder().encode(page.snapshot.dashboard).count <= 24_000 else { throw HostRoutingError.invalidReference }
        let baseline = state.status?.publishedRevision ?? 0
        guard (0..<ControlCourierAPI.maximumCounter).contains(baseline) else { throw HostRoutingError.invalidReference }
        let result: ControlRemoteStatusImportResponse = try await home.post(binding.bindingId, ["status", "import"],
            ControlRemoteStatusImportRequest(page: page, expectedPublishedRevision: baseline), scope: .status)
        try fence.check()
        guard result.snapshotId == page.snapshot.snapshotId, result.next == page.next,
              (result.state == .published) == (page.next == nil),
              result.publishedRevision == baseline + (result.state == .published ? 1 : 0) else {
            throw ControlCourierFailure(.reconciliationRequired)
        }
        freshStatus = false
        return page.next != nil
    }

    private func reads(_ fence: ControlCourierScheduler.Fence) async throws -> Bool {
        let page: ControlReadExchangeResponse = try await home.post(binding.bindingId, ["reads", "exchange"],
            ControlReadExchangeRequest(peer: binding.executor, cursor: readCursor), scope: .reads)
        try fence.check()
        guard page.requests.count <= 16, page.more == (page.next != nil), validCursor(page.next),
              page.next == nil || page.next != readCursor else { throw HostRoutingError.invalidReference }
        for request in page.requests {
            guard request.host == binding.executor else { throw HostRoutingError.identityChanged }
            let outcome: ControlRemoteReadOutcome
            do {
                let response: ControlRemoteReadResponse = try await target.post(binding.bindingId, ["reads", "execute"], request, scope: .reads)
                try fence.check()
                guard response.requestId == request.requestId, response.sourceHost == binding.executor,
                      response.untrusted, response.availability == .available,
                      try JSONEncoder().encode(response).count <= 24_000 else { throw HostRoutingError.identityChanged }
                outcome = ControlRemoteReadOutcome(requestId: request.requestId, host: request.host, availability: .available, response: response)
            } catch let error as URLError where error.code != .cancelled {
                try fence.check()
                outcome = try unavailableRead(request, availability: .disconnected, code: .readUnavailable)
            } catch let error as ControlCourierFailure {
                try fence.check()
                outcome = try unavailableRead(request, availability: .unknown, code: error.code ?? .readUnavailable)
            }
            let imported: ControlReadImportResponse = try await home.post(binding.bindingId, ["reads", "import"],
                ControlReadImportRequest(outcome: outcome), scope: .reads)
            try fence.check()
            guard imported.requestId == request.requestId else { throw HostRoutingError.identityChanged }
        }
        readCursor = page.next
        return page.more
    }

    private func unavailableRead(_ request: ControlRemoteReadRequest, availability: ControlHostAvailability,
                                 code: ControlHostErrorResponse.Code) throws -> ControlRemoteReadOutcome {
        let error = try ControlCourierAPI.value(ControlHostErrorResponse.self, [
            "code": .string(code.rawValue), "error": .string("The selected host could not complete this read."),
        ])
        return ControlRemoteReadOutcome(requestId: request.requestId, host: request.host, availability: availability, error: error)
    }

    private func validCursor(_ value: String?) -> Bool { value == nil || (!value!.isEmpty && value!.utf8.count <= 512) }
    private func json<T: Encodable>(_ value: T) throws -> JSONValue { try JSONValue.decode(JSONEncoder().encode(value)) }
}
