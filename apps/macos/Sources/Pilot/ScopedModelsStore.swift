import Darwin
import Foundation

/// Single writer for app intent/outcomes. Encoding, fsync and replacement run off the UI actor.
/// A corrupt/unknown index fences all writes; it is never treated as an empty preference.
actor ScopedModelsStore {
    private let directory: URL
    private var cached: ScopedModelsState?
    private var failure: Error?

    init(directory: URL) { self.directory = directory }

    /// Actor barrier only, without loading user files for an owner that was never started.
    func settled() {}

    func load() throws -> ScopedModelsState {
        if let failure { throw failure }
        if let cached { return cached }
        do {
            let url = directory.appendingPathComponent("scoped-models.json")
            let state: ScopedModelsState
            if FileManager.default.fileExists(atPath: url.path) {
                guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 8 * 1024 * 1024 else {
                    throw ScopedModelsFailure.storage
                }
                state = try JSONDecoder().decode(ScopedModelsState.self, from: Data(contentsOf: url))
                try state.validate()
            } else { state = ScopedModelsState() }
            cached = state
            return state
        } catch { failure = error; throw error }
    }

    @discardableResult func update(_ change: @Sendable (inout ScopedModelsState) throws -> Void) throws -> ScopedModelsState {
        var state = try load()
        try change(&state)
        guard state != cached else { return state }
        guard state.sequence < UInt64.max else { throw ScopedModelsFailure.storage }
        state.sequence += 1
        try state.validate()
        do {
            let data = try JSONEncoder().encode(state)
            guard data.count <= 8 * 1024 * 1024 else { throw ScopedModelsFailure.storage }
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                   attributes: [.posixPermissions: 0o700])
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
            let temp = directory.appendingPathComponent(UUID().uuidString + ".tmp")
            defer { try? FileManager.default.removeItem(at: temp) }
            try data.write(to: temp, options: .withoutOverwriting)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temp.path)
            let file = try FileHandle(forWritingTo: temp)
            do { try file.synchronize(); try file.close() } catch { try? file.close(); throw error }
            guard rename(temp.path, directory.appendingPathComponent("scoped-models.json").path) == 0 else {
                throw POSIXError(.EIO)
            }
            let fd = open(directory.path, O_RDONLY)
            guard fd >= 0 else { throw POSIXError(.EIO) }
            defer { close(fd) }
            guard fsync(fd) == 0 else { throw POSIXError(.EIO) }
            cached = state
            return state
        } catch {
            // Includes uncertain rename/fsync outcomes. Never send from unconfirmed durable intent.
            failure = error
            throw error
        }
    }
}
