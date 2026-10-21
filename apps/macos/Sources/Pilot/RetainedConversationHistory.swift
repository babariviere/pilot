import Combine
import Foundation
import PilotCore

struct RetainedConversationPage: Sendable {
    let entries: [Entry]
    let next: Int?
    let bytes: Int
}

/// Closed read-only interface. No subscription, message, stop, restore or permission operation.
@MainActor protocol RetainedConversationReading: AnyObject {
    var reference: HostResourceRef { get }
    var available: Bool { get }
    func read(before: Int) async throws -> RetainedConversationPage
}

@MainActor final class RetainedConversationReader: RetainedConversationReading {
    let reference: HostResourceRef
    let hosts: ClientDirectory
    var available: Bool { hosts.available.contains(reference.host) }
    init(reference: HostResourceRef, hosts: ClientDirectory) { self.reference = reference; self.hosts = hosts }

    func read(before: Int) async throws -> RetainedConversationPage {
        guard reference.kind == .session, hosts.sessions.contains(where: { $0.ref == reference && $0.value.isRetainedHistory }) else {
            throw HostRoutingError.invalidReference
        }
        let token = try hosts.token(for: reference.host)
        let page: JSONValue = try await hosts.perform(reference, kind: .session) { client, id in
            try await client.resourceRequest(["sessions", id, "history"], query: [
                URLQueryItem(name: "before", value: String(before)), URLQueryItem(name: "limit", value: "40"),
            ], maximumBytes: 2 * 1024 * 1024)
        }
        let result = try await Task.detached(priority: .utility) {
            guard let raw = page["entries"]?.array, let more = page["more"]?.bool, raw.count <= 40 else {
                throw HostRoutingError.invalidReference
            }
            let entries = try raw.map { value -> Entry in
                guard let entry = Entry(json: value), entry.id >= 0, entry.id < before else { throw HostRoutingError.invalidReference }
                return entry
            }
            guard entries.map(\.id) == entries.map(\.id).sorted(), Set(entries.map(\.id)).count == entries.count,
                  !more || !entries.isEmpty else { throw HostRoutingError.invalidReference }
            return RetainedConversationPage(entries: entries, next: more ? entries.first?.id : nil, bytes: try JSONEncoder().encode(page).count)
        }.value
        try hosts.validate(token)
        try Task.checkCancellation()
        return result
    }
}

@MainActor final class RetainedConversationHistoryModel: ObservableObject {
    static let latest = 9_007_199_254_740_991
    let source: RetainedConversationReading
    @Published private(set) var entries: [Entry] = []
    @Published private(set) var next: Int?
    @Published private(set) var loaded = false
    @Published private(set) var busy = false
    @Published private(set) var error: String?
    @Published private(set) var limited = false
    private var revision = UUID()
    private var request: Task<RetainedConversationPage, Error>?
    private var retainedBytes = 0
    init(source: RetainedConversationReading) { self.source = source }
    var canLoadOlder: Bool { next != nil && entries.count < 400 && !limited && !busy }

    func load(older: Bool = false) async {
        guard !older || canLoadOlder else { return }
        if !older { limited = false }
        let before = older ? next! : Self.latest
        request?.cancel()
        let epoch = UUID(); revision = epoch
        let source = self.source
        let task = Task { try await source.read(before: before) }
        request = task; busy = true; error = nil
        defer { if revision == epoch { busy = false; request = nil } }
        do {
            let page = try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
            try Task.checkCancellation()
            guard revision == epoch else { return }
            guard source.available else { throw HostRoutingError.disconnected }
            let combined = older ? page.entries + entries : page.entries
            let bytes = page.bytes + (older ? retainedBytes : 0)
            guard combined.count <= 400, Set(combined.map(\.id)).count == combined.count,
                  page.next == nil || (page.next! >= 0 && page.next! < before),
                  bytes >= 0, bytes <= 2 * 1024 * 1024 else {
                throw CocoaError(.fileReadTooLarge)
            }
            entries = combined; next = page.next; retainedBytes = bytes; loaded = true
        } catch {
            guard revision == epoch, !Task.isCancelled else { return }
            if let failure = error as? CocoaError, failure.code == .fileReadTooLarge { limited = true }
            self.error = source.available
                ? "Could not read this history. Previously loaded messages were kept."
                : "Reconnect to the original host to load this history. Previously loaded messages were kept."
        }
    }
    func stop() { revision = UUID(); request?.cancel(); request = nil; busy = false }
}
