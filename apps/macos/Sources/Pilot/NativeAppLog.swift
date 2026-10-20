import Darwin
import Foundation
import PilotCore

/// Deliberately not a console interceptor. Only closed app-owned events and error codes reach disk.
final class NativeAppLog: @unchecked Sendable {
    enum Event: String, Codable, Sendable {
        case appStarted = "app_started", appTerminating = "app_terminating"
        case transportFailed = "transport_failed", repairStartFailed = "repair_start_failed"
        case repairArchiveFailed = "repair_archive_failed", repairStarted = "repair_started"
    }
    static let shared = NativeAppLog(directory: FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Logs/Pilot/App", isDirectory: true))
    static let segmentBytes = 256 * 1024
    static let retention: TimeInterval = 7 * 24 * 60 * 60
    private struct Record: Codable, Sendable {
        let schemaVersion: Int
        let at: String
        let host: OperationHost
        let event: Event
        let errorDomain: String?
        let errorCode: Int?
    }
    private let directory: URL
    private let queue = DispatchQueue(label: "app.diagnostic-log", qos: .utility)
    private let lock = NSLock()
    private var enabled = false
    private var host: OperationHost?
    private var generation: UInt64 = 0
    private var pending = 0
    private var reportedStart = false
    private var failed = false
    var writeFailed: Bool { lock.withLock { failed } }

    init(directory: URL) { self.directory = directory }
    var isEnabled: Bool { lock.withLock { enabled } }
    func setEnabled(_ value: Bool) { lock.withLock { if enabled != value { generation &+= 1 }; enabled = value } }
    func setHost(_ value: HostRef) {
        lock.withLock { if host != OperationHost(value) { generation &+= 1 }; host = OperationHost(value) }
    }

    func record(_ event: Event, error: (any Error)? = nil, now: Date = Date()) {
        let admission = lock.withLock { () -> (OperationHost, UInt64)? in
            guard enabled, let host, pending < 64 else { return nil }
            if event == .appStarted { if reportedStart { return nil }; reportedStart = true }
            pending += 1
            return (host, generation)
        }
        guard let (host, revision) = admission else { return }
        // Never persist localizedDescription, userInfo, stacks, URLs, paths or arbitrary error domains.
        let cause = error as NSError?
        let allowed = [NSURLErrorDomain, NSCocoaErrorDomain, NSPOSIXErrorDomain]
        let domain = cause.map { allowed.contains($0.domain) ? $0.domain : "other" }
        let code = cause.flatMap { (-1_000_000 ... 1_000_000).contains($0.code) ? $0.code : nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let record = Record(schemaVersion: 1, at: formatter.string(from: now), host: host, event: event, errorDomain: domain, errorCode: code)
        queue.async {
            defer { self.lock.withLock { self.pending -= 1 } }
            guard self.lock.withLock({ self.enabled && self.generation == revision }) else { return }
            do { try self.append(record, now: now); self.lock.withLock { self.failed = false } }
            catch { self.lock.withLock { self.failed = true } } // Never log a logger failure recursively.
        }
    }

    func flush() async {
        await withCheckedContinuation { continuation in queue.async { continuation.resume() } }
    }
    func clear() async throws {
        lock.withLock { generation &+= 1 }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            queue.async {
                do {
                    if FileManager.default.fileExists(atPath: self.directory.path) { try self.validateDirectory() }
                    for name in ["app.jsonl", "app.jsonl.1"] {
                        let file = self.directory.appendingPathComponent(name)
                        if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
                    }
                    continuation.resume()
                } catch { continuation.resume(throwing: error) }
            }
        }
    }

    private func validateDirectory() throws {
        var stat = stat()
        guard lstat(directory.path, &stat) == 0, (stat.st_mode & S_IFMT) == S_IFDIR,
              stat.st_uid == getuid(), stat.st_mode & 0o077 == 0,
              directory.resolvingSymlinksInPath().path == directory.standardizedFileURL.path else { throw CocoaError(.fileWriteNoPermission) }
    }
    private func read(_ file: URL, now: Date) throws -> Data {
        let fd = open(file.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        if fd < 0, errno == ENOENT { return Data() }
        guard fd >= 0 else { throw CocoaError(.fileReadNoPermission) }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close() }
        var stat = stat()
        guard fstat(fd, &stat) == 0, (stat.st_mode & S_IFMT) == S_IFREG, stat.st_uid == getuid(),
              stat.st_mode & 0o077 == 0, stat.st_size <= Int64(Self.segmentBytes) else { throw CocoaError(.fileReadTooLarge) }
        let bytes = try handle.read(upToCount: Self.segmentBytes + 1) ?? Data()
        guard bytes.count <= Self.segmentBytes else { throw CocoaError(.fileReadTooLarge) }
        // Drop expired/malformed records before rewriting. No raw record ever gets forwarded to a logger.
        return bytes.split(separator: 10).reduce(into: Data()) { result, line in
            guard line.count <= 2048, let item = try? JSONDecoder().decode(Record.self, from: Data(line)),
                  item.schemaVersion == 1, item.host.hostId == "daemon",
                  item.host.daemonId.utf8.count <= 256, item.host.lineageId.utf8.count <= 256,
                  item.errorDomain == nil || [NSURLErrorDomain, NSCocoaErrorDomain, NSPOSIXErrorDomain, "other"].contains(item.errorDomain!),
                  item.errorCode == nil || (-1_000_000 ... 1_000_000).contains(item.errorCode!),
                  let at = Self.date(item.at), now.timeIntervalSince(at) <= Self.retention, at <= now else { return }
            if let safe = try? JSONEncoder().encode(item) { result.append(safe); result.append(10) }
        }
    }
    private static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)
    }
    private func replace(_ data: Data, file: URL) throws {
        let temp = directory.appendingPathComponent(UUID().uuidString + ".tmp")
        defer { try? FileManager.default.removeItem(at: temp) }
        let fd = open(temp.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw CocoaError(.fileWriteUnknown) }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close() }
        try handle.write(contentsOf: data)
        guard rename(temp.path, file.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
    }
    private func append(_ record: Record, now: Date) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        try validateDirectory()
        let file = directory.appendingPathComponent("app.jsonl")
        let rotated = directory.appendingPathComponent("app.jsonl.1")
        var current = try read(file, now: now)
        let previous = try read(rotated, now: now)
        var line = try JSONEncoder().encode(record); line.append(10)
        guard line.count <= 2048 else { throw CocoaError(.fileWriteOutOfSpace) }
        if current.count + line.count > Self.segmentBytes {
            try replace(current, file: rotated); current = Data()
        } else { try replace(previous, file: rotated) }
        current.append(line)
        try replace(current, file: file)
    }
}
