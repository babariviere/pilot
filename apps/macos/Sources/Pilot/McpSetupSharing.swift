import Combine
import Foundation
import PilotCore

enum McpSetupFailure: Error { case unavailable, unsupported, changed, conflict, manualSetup, dependencyMissing, invalid }

@MainActor final class McpSetupSharing: ObservableObject {
    struct Endpoint {
        let token: HostConnectionToken
        let current: () -> Bool
        let read: () async throws -> McpSetupSnapshot
        let apply: (McpSetupApplyRequest) async throws -> Void
    }
    struct Review {
        let source: Endpoint
        let target: Endpoint
        let local: McpSetupSnapshot
        let remote: McpSetupSnapshot
    }
    let sourceHost: HostRef
    let targetHost: HostRef
    private let endpoint: (HostRef) throws -> Endpoint
    private var generation = UUID()
    private var attempted: McpSetupApplyRequest?
    @Published private(set) var review: Review?
    @Published var selected: Set<String> = []
    @Published private(set) var busy = false
    @Published private(set) var uncertain = false
    @Published private(set) var problem: String?
    @Published private(set) var notice: String?

    init(source: HostRef, target: HostRef, endpoint: @escaping (HostRef) throws -> Endpoint) {
        sourceHost = source; targetHost = target; self.endpoint = endpoint
    }

    func prepare() async {
        guard !busy, !uncertain, sourceHost.hostId == "local", targetHost.hostId != "local" else { return }
        busy = true; defer { busy = false }
        review = nil; selected.removeAll(); attempted = nil
        let generation = generation
        do {
            let source = try endpoint(sourceHost), target = try endpoint(targetHost)
            guard source.token.host == sourceHost, target.token.host == targetHost else { throw McpSetupFailure.invalid }
            let local = try await source.read()
            guard source.current(), target.current(), self.generation == generation else { return }
            let remote = try await target.read()
            guard source.current(), target.current(), self.generation == generation else { return }
            guard local.schemaVersion == 1, remote.schemaVersion == 1, remote.writeMode == "additive" else { throw McpSetupFailure.unsupported }
            review = Review(source: source, target: target, local: local, remote: remote)
            selected.removeAll(); attempted = nil; problem = nil; notice = nil
        } catch { if self.generation == generation { problem = Self.message(error) } }
    }

    func selectable(_ entry: McpSetupEntry) -> Bool {
        guard let review, entry.blocked == nil, entry.config?.shareable == true,
              entry.name.range(of: #"^[A-Za-z0-9_-]{1,64}$"#, options: .regularExpression) != nil else { return false }
        let name = entry.name.replacingOccurrences(of: "-", with: "_")
        return !review.remote.entries.contains { $0.name.replacingOccurrences(of: "-", with: "_") == name }
    }

    func entryNotice(_ entry: McpSetupEntry, targetName: String) -> String {
        let name = entry.name.replacingOccurrences(of: "-", with: "_")
        if let existing = review?.remote.entries.first(where: { $0.name.replacingOccurrences(of: "-", with: "_") == name }) {
            if existing.name == entry.name, existing.blocked == nil, existing.config == entry.config {
                return "Already present on \(targetName). Kept unchanged."
            }
            return "Conflicts with \(existing.name) on \(targetName). Kept unchanged; resolve it on that host."
        }
        return "Advanced, secret-bearing or host-specific setup. Configure this server on \(targetName) directly."
    }

    func apply() async {
        guard !busy, !uncertain, let review, !selected.isEmpty else { return }
        let entries = review.local.entries.filter { selected.contains($0.name) }
        guard entries.count == selected.count, entries.allSatisfy({ selectable($0) }) else { problem = Self.message(McpSetupFailure.conflict); return }
        let desired = entries.compactMap { entry in entry.config.map { McpSetupApplyRequest.Entry(name: entry.name, config: $0) } }
        let input = McpSetupApplyRequest(expectedRevision: review.remote.revision, entries: desired)
        busy = true; problem = nil; defer { busy = false }
        let generation = generation
        do {
            guard review.source.current(), review.target.current() else { throw McpSetupFailure.changed }
            let source = try await review.source.read()
            guard self.generation == generation, review.source.current(), review.target.current() else { return }
            guard source.revision == review.local.revision else { throw McpSetupFailure.changed }
            let target = try await review.target.read()
            guard self.generation == generation, review.source.current(), review.target.current() else { return }
            guard target.revision == review.remote.revision else { throw McpSetupFailure.changed }
            // Save the reviewed desired value before dispatch. An uncertain delivery gets lookup only.
            attempted = input; uncertain = true
            do { try await review.target.apply(input) }
            catch McpSetupFailure.manualSetup {
                uncertain = false; attempted = nil; throw McpSetupFailure.manualSetup
            }
            catch McpSetupFailure.dependencyMissing {
                uncertain = false; attempted = nil; throw McpSetupFailure.dependencyMissing
            }
            catch McpSetupFailure.conflict {
                uncertain = false; attempted = nil; throw McpSetupFailure.conflict
            }
            catch {
                // Errors, including 503, may follow a committed write. Never repeat the PUT here.
            }
            guard self.generation == generation, review.source.current(), review.target.current() else { return }
            let readback = try await review.target.read()
            guard self.generation == generation, review.source.current(), review.target.current() else { return }
            reconcile(readback, desired: input)
        } catch { if self.generation == generation { problem = Self.message(error) } }
    }

    /// May acquire a new socket for the exact same pinned installation. Never resends the write.
    func checkResult() async {
        guard !busy, uncertain, let attempted else { return }
        busy = true; defer { busy = false }
        let generation = generation
        do {
            let target = try endpoint(targetHost)
            guard target.token.host == targetHost else { throw McpSetupFailure.changed }
            let value = try await target.read()
            guard self.generation == generation, target.current() else { return }
            reconcile(value, desired: attempted)
        } catch { if self.generation == generation { problem = Self.message(error) } }
    }

    private func reconcile(_ value: McpSetupSnapshot, desired: McpSetupApplyRequest) {
        guard value.schemaVersion == 1 else { problem = Self.message(McpSetupFailure.unsupported); return }
        let matches = desired.entries.allSatisfy { entry in
            value.entries.contains { $0.name == entry.name && $0.blocked == nil && $0.config == entry.config }
        }
        if matches {
            uncertain = false; selected.removeAll(); problem = nil
            if let review { self.review = Review(source: review.source, target: review.target, local: review.local, remote: value) }
            notice = "The reviewed setup is present on this devbox. Authentication is separate. Recheck its MCP connections; running chats pick up setup changes after reload or a new session."
        } else {
            problem = "The reviewed setup could not be confirmed. Existing configuration was kept. Check the result or review the host's configuration manually; no write will be repeated automatically."
        }
    }

    func cancelReview() { generation = UUID() }

    private static func message(_ error: Error) -> String {
        switch error as? McpSetupFailure {
        case .unsupported: "This runtime does not support reviewed setup sharing. Update it, or configure MCP on that host directly."
        case .changed: "The host connection or reviewed configuration changed. Review it again before applying."
        case .conflict: "The devbox's configuration changed or a server name conflicts. Existing setup was kept. Review it again; no entry was replaced."
        case .manualSetup: "This configuration needs manual setup on the devbox. No existing entry was replaced."
        case .dependencyMissing: "The MCP executable is missing or unusable on this devbox's PATH. Install or configure it on that host, then review setup again. No packages were installed."
        default: "Setup could not be confirmed on this host. Reconnect and check the reviewed result. No credentials or raw configuration were shared."
        }
    }
}

extension McpSetupSharing {
    convenience init(source: HostRef, target: HostRef, hosts: HostClients,
                     readCapability: @escaping @MainActor (HostRef, SSHConnectionConfiguration?) async throws -> String = {
                         try await GitHubNativeAccess.read(host: $0, configuration: $1)
                     }) {
        self.init(source: source, target: target) { [weak hosts] host in
            guard let hosts, host.hostId == "local" || hosts.offlineHosts[host] != nil else { throw HostRoutingError.disconnected }
            let token = try hosts.token(for: host), client = try hosts.endpoint(host)
            let configuration = hosts.offlineHosts[host]?.configuration
            let current = { [weak hosts] in
                guard let hosts else { return false }
                return (try? hosts.validate(token)) != nil
            }
            return McpSetupTransport(client: client, token: token, current: current,
                capability: { try await readCapability(host, configuration) }).endpoint()
        }
    }
}
