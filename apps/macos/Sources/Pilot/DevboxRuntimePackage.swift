import Darwin
import Foundation
import PilotCore

/// Supplied by the app's authenticated release-access owner. Never place its token in view/model state.
typealias DevboxPackageLoader = @MainActor () async throws -> LinuxRuntimePackage

/// Production default. Only an explicit Setup/Update action calls it. No token becomes model state.
@MainActor
enum DevboxRuntimePackage {
    private static var cached: LinuxRuntimePackage?
    private static var loading: Task<LinuxRuntimePackage, Error>?

    static func load() async throws -> LinuxRuntimePackage {
        if let cached {
            try await Task.detached { try cached.manifest.verifyArchive(at: cached.archiveURL) }.value
            return cached
        }
        if let loading { return try await loading.value }
        let task = Task { try await download() }
        loading = task
        defer { loading = nil }
        let package = try await task.value
        cached = package
        return package
    }

    private static func download() async throws -> LinuxRuntimePackage {
        let bundle = Bundle.main
        guard let encoded = bundle.object(forInfoDictionaryKey: "PilotLinuxRuntimePublicKey") as? String,
              Data(base64Encoded: encoded)?.count == 32 else { throw DevboxPackageFailure.trust }
        guard let name = bundle.object(forInfoDictionaryKey: "PilotUpdateRepository") as? String,
              let repository = UpdateRepository(name),
              let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
              version.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression) != nil else { throw DevboxPackageFailure.assets }
        guard let access = try await UpdateAccessResolver.resolve(cliToken: { await UpdateCredentials.localGitHubToken() },
            savedToken: { try UpdateCredentials.read() }) else { throw DevboxPackageFailure.access }
        // Fetch the exact compatible app version, never silently install a newer/different runtime.
        let tag = "v" + version
        let url = repository.latestReleaseURL.deletingLastPathComponent().appendingPathComponent("tags").appendingPathComponent(tag)
        func metadata(_ token: String) async throws -> (Data, HTTPURLResponse) {
            var request = URLRequest(url: url)
            request.timeoutInterval = 30
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
            return try await BoundedHTTPData.read(request, maximumBytes: 1_048_576)
        }
        var token = access.token
        var (data, response) = try await metadata(token)
        if [401, 403, 404].contains(response.statusCode), access.source == .githubCLI,
           let saved = GitHubTokenCommand.validToken(try UpdateCredentials.read()), saved != token {
            token = saved
            (data, response) = try await metadata(token)
        }
        guard response.statusCode == 200 else { throw DevboxPackageFailure.access }
        struct Tag: Decodable { let tag_name: String }
        guard try JSONDecoder().decode(Tag.self, from: data).tag_name == tag else { throw DevboxPackageFailure.assets }
        let release = try JSONDecoder().decode(UpdateRelease.self, from: data)
        guard release.linuxRuntimeAssets() != nil else { throw DevboxPackageFailure.assets }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("pilot-runtime-" + UUID().uuidString, isDirectory: true)
        try await Task.detached {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        }.value
        do {
            let package = try await LinuxRuntimePackage.download(release: release, repository: repository, token: token,
                releaseTag: tag, expectedVersion: version, bundle: bundle, to: directory.appendingPathComponent("runtime.tgz"))
            return package
        } catch {
            await Task.detached { try? FileManager.default.removeItem(at: directory) }.value
            throw error
        }
    }
}

enum DevboxPackageFailure: Error { case trust, assets, access }

enum DevboxProblem: Error, Equatable {
    case savedUpdate, packageChanged, storage, invalidAlias
}

/// Plain, fixed UI copy. Never render raw SSH, URLSession, SDK or credential errors.
enum DevboxProblemText {
    static func setup(_ error: Error) -> String {
        if let failure = error as? DevboxPackageFailure {
            switch failure {
            case .trust: return "This app has no trusted Linux runtime signing key. Install a configured app release. Verification cannot be skipped."
            case .assets: return "This app release has no complete signed Linux runtime. Wait for verified release assets. There is no source or unsigned fallback."
            case .access: return "The compatible release could not be downloaded. Check GitHub access in Updates settings or run gh auth login, then try again."
            }
        }
        if error is CancellationError { return "Setup was interrupted. Remote setup may have progressed. Retry the same package to check it." }
        if let validation = error as? LinuxRuntimeManifest.ValidationError {
            switch validation {
            case .signature: return "The runtime signature did not verify against this app's trusted key. No unverified package will be installed."
            case .incompatible: return "The signed runtime does not match this app's version, platform or protocol. Install a compatible trusted app release."
            case .archive: return "The runtime archive failed its size or integrity check. Download a complete verified package before retrying."
            }
        }
        if error as? DevboxProblem == .invalidAlias { return "Enter an existing SSH alias, such as personal-box. Configure SSH authentication and host trust outside Pilot first." }
        if let failure = error as? LinuxBootstrapFailure {
            switch failure.code {
            case "trust": return "This app has no trusted Linux runtime signing key. Install a configured app release. Verification cannot be skipped."
            case "assets": return "The signed Linux runtime is unavailable or incomplete. Wait for complete verified release assets. There is no unsigned fallback."
            case "python": return "Python 3.9 or newer is required on this devbox. Review the required package installation outside Pilot, then retry."
            case "prerequisites", "persistence": return "The persistent user service is not ready. Review the package, user-manager and linger requirements outside Pilot. No privileged changes were made automatically."
            case "sandbox": return "The service is reachable, but coordinator isolation is unavailable. Review bubblewrap and the service's namespace/security policy. Do not weaken global security."
            case "identity": return "This devbox no longer matches its saved identity. Check the SSH alias and saved installation before continuing."
            case "service": return "The owned user service needs repair. Check journalctl --user -u pilotd. Setup never replaces a foreign service or restarts active work."
            default: break
            }
        }
        if let routing = error as? HostRoutingError, routing == .identityChanged || routing == .incompatible {
            return "The devbox identity or runtime is incompatible. Check the saved pin and install a trusted compatible release."
        }
        return "Setup could not be confirmed. Check the existing SSH alias, host trust and non-interactive authentication. Retry the same verified package; no remote stop was sent."
    }

    /// Update of an unsaved devbox from the setup sheet. Retrying reuses the same request.
    static func setupUpdate(_ error: Error) -> String {
        if error is DevboxPackageFailure || error is LinuxRuntimeManifest.ValidationError { return setup(error) }
        if let failure = error as? LinuxBootstrapFailure {
            switch failure.code {
            case "assets", "trust", "python", "sandbox": return setup(error)
            case "update-pending": return "The update was requested but is not active yet. It may be waiting for work on the devbox to finish. Try again to check the same update."
            case "newer-runtime": return "The devbox runs a newer Pilot runtime. Update this app first. Downgrades are not supported."
            case "identity": return "The devbox identity changed during setup. Close this form and start setup again."
            default: break
            }
        }
        if let routing = error as? HostRoutingError, routing == .identityChanged || routing == .incompatible {
            return setup(error)
        }
        return "The update has no confirmed result. It may continue on the devbox. Try again to check the same update; no remote stop was sent."
    }

    static func update(_ error: Error) -> String {
        if error is DevboxPackageFailure { return setup(error) }
        switch error as? DevboxProblem {
        case .storage: return "The update request could not be saved safely. No update was dispatched. Repair local storage before retrying."
        case .packageChanged: return "This pending update requires its original verified package. Check its saved status; do not replace it with a different release."
        case .savedUpdate: return "A previous update still needs reconciliation. Check that request before starting another update."
        default: break
        }
        if let failure = error as? LinuxBootstrapFailure, ["assets", "trust"].contains(failure.code) { return setup(error) }
        return "The update has no confirmed result. It may continue independently. Reconnect and check the saved update; do not start a new request."
    }
}

struct DevboxUpdateIntent: Codable, Equatable, Sendable {
    let id: UUID
    let host: HostRef
    let version: String
    let archive: String
    var conclusive = false
}

/// Private metadata only. Synchronous filesystem work stays on this actor, never the UI actor.
actor DevboxUpdateIntentStore {
    private struct Index: Codable { let schema: Int; var intents: [DevboxUpdateIntent] }
    private let directory: URL
    private var failure = false

    init(directory: URL) { self.directory = directory }

    static let shared = DevboxUpdateIntentStore(directory: FileManager.default.urls(for: .applicationSupportDirectory,
        in: .userDomainMask)[0].appendingPathComponent("Pilot/DevboxUpdates", isDirectory: true))

    func current(_ host: HostRef) throws -> DevboxUpdateIntent? { try read().intents.first { $0.host == host } }

    /// Returns the same UUID for an unresolved request. Never silently replaces its pin or package.
    func reserve(host: HostRef, version: String, archive: String) throws -> DevboxUpdateIntent {
        var index = try read()
        guard host.hostId != "local", !host.hostId.isEmpty, !host.daemonId.isEmpty, !host.lineageId.isEmpty,
              version.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression) != nil,
              archive.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil,
              !index.intents.contains(where: { $0.host.hostId == host.hostId && $0.host != host }) else { throw DevboxProblem.storage }
        if let previous = index.intents.first(where: { $0.host == host }), !previous.conclusive {
            guard previous.version == version, previous.archive == archive else { throw DevboxProblem.packageChanged }
            return previous
        }
        let intent = DevboxUpdateIntent(id: UUID(), host: host, version: version, archive: archive)
        index.intents.removeAll { $0.host == host }
        guard index.intents.count < 32 else { throw DevboxProblem.storage }
        index.intents.append(intent)
        try save(index)
        return intent
    }

    func markConclusive(host: HostRef, id: UUID) throws {
        var index = try read()
        guard let offset = index.intents.firstIndex(where: { $0.host == host && $0.id == id }) else { return }
        index.intents[offset].conclusive = true
        try save(index)
    }

    private func read() throws -> Index {
        guard !failure else { throw DevboxProblem.storage }
        let url = directory.appendingPathComponent("updates.json")
        do {
            if FileManager.default.fileExists(atPath: directory.path) {
                let values = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                guard values.isDirectory == true, values.isSymbolicLink != true else { throw DevboxProblem.storage }
            }
            guard FileManager.default.fileExists(atPath: url.path) else { return Index(schema: 1, intents: []) }
            let metadata = try url.resourceValues(forKeys: [.fileSizeKey, .isSymbolicLinkKey])
            guard metadata.isSymbolicLink != true, (metadata.fileSize ?? Int.max) <= 65_536 else { throw DevboxProblem.storage }
            let index = try JSONDecoder().decode(Index.self, from: Data(contentsOf: url))
            guard index.schema == 1, index.intents.count <= 32,
                  Set(index.intents.map { $0.host.hostId }).count == index.intents.count,
                  index.intents.allSatisfy({ $0.host.hostId != "local" && !$0.host.hostId.isEmpty && !$0.host.daemonId.isEmpty && !$0.host.lineageId.isEmpty &&
                    $0.version.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression) != nil &&
                    $0.archive.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil }) else { throw DevboxProblem.storage }
            return index
        } catch { failure = true; throw DevboxProblem.storage }
    }

    private func save(_ index: Index) throws {
        do {
            let data = try JSONEncoder().encode(index)
            guard data.count <= 65_536 else { throw DevboxProblem.storage }
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let info = try directory.resourceValues(forKeys: [.isSymbolicLinkKey])
            guard info.isSymbolicLink != true else { throw DevboxProblem.storage }
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
            let temp = directory.appendingPathComponent(UUID().uuidString + ".tmp")
            defer { try? FileManager.default.removeItem(at: temp) }
            try data.write(to: temp, options: .withoutOverwriting)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temp.path)
            let file = try FileHandle(forWritingTo: temp)
            do { try file.synchronize(); try file.close() } catch { try? file.close(); throw error }
            guard rename(temp.path, directory.appendingPathComponent("updates.json").path) == 0 else { throw DevboxProblem.storage }
            let fd = open(directory.path, O_RDONLY)
            guard fd >= 0 else { throw DevboxProblem.storage }
            defer { close(fd) }
            guard fsync(fd) == 0 else { throw DevboxProblem.storage }
        } catch { failure = true; throw DevboxProblem.storage }
    }
}
