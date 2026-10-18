import CryptoKit
import Foundation
import MetricKit
import PilotCore

let nativeDiagnosticLimit = 32
let nativeDiagnosticRetention: TimeInterval = 7 * 24 * 60 * 60
enum NativeDiagnosticArchiveError: Error { case corrupt }

actor NativeDiagnosticArchive {
    private let file: URL
    private var loaded = false
    private var loadFailed = false
    private var evidence: [NativeDiagnosticEvidence] = []
    private var dropped = 0

    init(directory: URL) {
        file = directory.appendingPathComponent("native-diagnostics.json")
    }

    func append(_ observations: [NativeDiagnosticEvidence], now: Date = Date()) throws -> Bool {
        try load()
        guard !loadFailed else { throw NativeDiagnosticArchiveError.corrupt }
        guard !observations.isEmpty else { return false }
        let cutoff = now.addingTimeInterval(-nativeDiagnosticRetention)
        var byRef = Dictionary(uniqueKeysWithValues: evidence.filter { Self.date($0.at).map { $0 >= cutoff } == true }
            .map { ($0.ref, $0) })
        let before = byRef.count
        for item in observations where Self.valid(item) { byRef[item.ref] = item }
        var next = byRef.values.sorted { $0.at > $1.at }
        if next.count > nativeDiagnosticLimit {
            dropped = min(1_000_000, dropped + next.count - nativeDiagnosticLimit)
            next.removeLast(next.count - nativeDiagnosticLimit)
        }
        guard next != evidence || byRef.count != before else { return false }
        evidence = next
        try persist()
        return true
    }

    func snapshot(now: Date = Date()) throws -> NativeDiagnosticsBatch {
        try load()
        guard !loadFailed else { throw NativeDiagnosticArchiveError.corrupt }
        let cutoff = now.addingTimeInterval(-nativeDiagnosticRetention)
        let current = evidence.filter { Self.date($0.at).map { $0 >= cutoff } == true }
        if current != evidence { evidence = current; try persist() }
        return NativeDiagnosticsBatch(evidence: evidence, dropped: dropped)
    }

    func clear() throws {
        loaded = true; loadFailed = false; evidence = []; dropped = 0
        try removeIfPresent(file)
        try removeIfPresent(file.deletingLastPathComponent().appendingPathComponent(".native-diagnostics.tmp"))
    }

    private func load() throws {
        guard !loaded else { return }
        loaded = true
        guard FileManager.default.fileExists(atPath: file.path) else { return }
        do {
            let values = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true, (values.fileSize ?? 0) <= 32 * 1024 else {
                loadFailed = true; return
            }
            let data = try Data(contentsOf: file)
            guard Self.closedSchema(data) else { loadFailed = true; return }
            let batch = try JSONDecoder().decode(NativeDiagnosticsBatch.self, from: data)
            guard batch.schemaVersion == 1, batch.evidence.count <= nativeDiagnosticLimit,
                  (0 ... 1_000_000).contains(batch.dropped), batch.evidence.allSatisfy(Self.valid),
                  Set(batch.evidence.map(\.ref)).count == batch.evidence.count,
                  Self.uniqueSetupSequences(batch.evidence) else { loadFailed = true; return }
            evidence = batch.evidence.sorted { $0.at > $1.at }
            dropped = batch.dropped
        } catch { loadFailed = true }
    }

    private func persist() throws {
        let directory = file.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        let data = try JSONEncoder().encode(NativeDiagnosticsBatch(evidence: evidence, dropped: dropped))
        guard data.count <= 32 * 1024 else { throw CocoaError(.fileWriteOutOfSpace) }
        let temporary = directory.appendingPathComponent(".native-diagnostics.tmp")
        let manager = FileManager.default
        try? manager.removeItem(at: temporary)
        guard manager.createFile(atPath: temporary.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        do {
            if manager.fileExists(atPath: file.path) {
                _ = try manager.replaceItemAt(file, withItemAt: temporary)
            } else {
                try manager.moveItem(at: temporary, to: file)
            }
            try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        } catch {
            try? manager.removeItem(at: temporary)
            throw error
        }
    }

    private func removeIfPresent(_ url: URL) throws {
        do { try FileManager.default.removeItem(at: url) }
        catch let error as CocoaError where error.code == .fileNoSuchFile {}
    }

    private static func valid(_ item: NativeDiagnosticEvidence) -> Bool {
        guard date(item.at) != nil else { return false }
        switch item.kind {
        case "native.crash", "native.hang":
            let ref = item.ref.range(of: #"^diagnostic:v1:native:[0-9a-f]{24}$"#,
                                     options: .regularExpression) != nil
            guard ref, item.source == .os, let window = item.windowMs, window.isFinite,
                  (0 ... 7 * 24 * 60 * 60 * 1_000).contains(window),
                  item.releaseRelation == "current" || item.releaseRelation == "other_or_unknown",
                  item.attemptRef == nil, item.sequence == nil, item.stage == nil, item.outcome == nil else { return false }
            if item.kind == "native.crash" { return item.reason == "process_exit" && item.durationMs == nil }
            guard item.reason == "unresponsive", let duration = item.durationMs else { return false }
            return duration.isFinite && (0 ... 86_400_000).contains(duration)
        case "devbox.setup":
            let ref = item.ref.range(of: #"^diagnostic:v1:setup:[0-9a-f]{24}$"#,
                                     options: .regularExpression) != nil
            let attempt = item.attemptRef?.range(of: #"^diagnostic:v1:setup-attempt:[0-9a-f]{24}$"#,
                                                 options: .regularExpression) != nil
            guard ref, attempt, item.source == .app, item.windowMs == nil, item.releaseRelation == nil,
                  item.durationMs == nil, let rawStage = item.stage,
                  DevboxSetupDiagnosticStage(rawValue: rawStage) != nil, let rawOutcome = item.outcome,
                  let outcome = DevboxSetupDiagnosticOutcome(rawValue: rawOutcome), let sequence = item.sequence,
                  (0 ... 31).contains(sequence) else { return false }
            let reason = item.reason.flatMap(DevboxSetupDiagnosticReason.init(rawValue:))
            if item.reason != nil, reason == nil { return false }
            switch outcome {
            case .started, .succeeded: return item.reason == nil
            case .failed: return reason != nil && reason != .cancelled
            case .cancelled: return reason == .cancelled
            }
        default: return false
        }
    }

    private static func uniqueSetupSequences(_ items: [NativeDiagnosticEvidence]) -> Bool {
        let setup = items.filter { $0.kind == "devbox.setup" }
        let keys = setup.compactMap { item in item.attemptRef.flatMap { attempt in item.sequence.map { "\(attempt):\($0)" } } }
        return keys.count == setup.count && Set(keys).count == keys.count
    }

    private static func closedSchema(_ data: Data) -> Bool {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(root.keys) == ["schemaVersion", "evidence", "dropped"],
              let evidence = root["evidence"] as? [[String: Any]] else { return false }
        let nativeRequired: Set<String> = ["ref", "source", "at", "kind", "reason", "windowMs", "releaseRelation"]
        let nativeAllowed = nativeRequired.union(["durationMs"])
        let setupRequired: Set<String> = ["ref", "attemptRef", "sequence", "source", "at", "kind", "stage", "outcome"]
        let setupAllowed = setupRequired.union(["reason"])
        return evidence.allSatisfy { item in
            let keys = Set(item.keys)
            if item["kind"] as? String == "devbox.setup" {
                return keys.isSubset(of: setupAllowed) && setupRequired.isSubset(of: keys)
            }
            return keys.isSubset(of: nativeAllowed) && nativeRequired.isSubset(of: keys)
        }
    }

    private static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)
    }
}

/// Stores bounded MetricKit observations and app-owned setup stages without raw diagnostic payloads.
final class NativeDiagnostics: NSObject, MXMetricManagerSubscriber, @unchecked Sendable {
    static let shared = NativeDiagnostics()
    private let archive: NativeDiagnosticArchive
    private let lock = NSLock()
    // Fail closed until the daemon returns the persisted host setting.
    private var enabled = false
    private var started = false
    private var changeHandler: (@Sendable () -> Void)?

    override init() {
        archive = NativeDiagnosticArchive(
            directory: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("Pilot/NativeDiagnostics", isDirectory: true)
        )
        super.init()
    }

    init(directory: URL) {
        archive = NativeDiagnosticArchive(directory: directory)
        super.init()
    }

    var isEnabled: Bool { lock.withLock { enabled } }

    func setEnabled(_ value: Bool) { lock.withLock { enabled = value } }
    func onChange(_ handler: (@Sendable () -> Void)?) { lock.withLock { changeHandler = handler } }

    func start() {
        let shouldStart = lock.withLock { () -> Bool in
            guard !started else { return false }
            started = true
            return true
        }
        if shouldStart { MXMetricManager.shared.add(self) }
    }

    func snapshot() async throws -> NativeDiagnosticsBatch { try await archive.snapshot() }
    func clear() async throws { try await archive.clear() }

    static func setupAttemptReference() -> String {
        "diagnostic:v1:setup-attempt:" + String(UUID().uuidString.lowercased()
            .replacingOccurrences(of: "-", with: "").prefix(24))
    }

    func recordSetup(attemptRef: String, sequence: Int, stage: DevboxSetupDiagnosticStage,
                     outcome: DevboxSetupDiagnosticOutcome, reason: DevboxSetupDiagnosticReason? = nil,
                     now: Date = Date()) async {
        guard isEnabled else { return }
        let suffix = String(UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "").prefix(24))
        let item = NativeDiagnosticEvidence(ref: "diagnostic:v1:setup:" + suffix, attemptRef: attemptRef,
                                            sequence: sequence, at: Self.timestamp(now), stage: stage,
                                            outcome: outcome, reason: reason)
        guard (try? await archive.append([item], now: now)) == true else { return }
        lock.withLock { changeHandler }?()
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        let observations = Self.observations(payloads)
        guard !observations.isEmpty, isEnabled else { return }
        Task {
            guard self.isEnabled, (try? await self.archive.append(observations)) == true else { return }
            self.lock.withLock { self.changeHandler }?()
        }
    }

    private static func observations(_ payloads: [MXDiagnosticPayload]) -> [NativeDiagnosticEvidence] {
        var result: [NativeDiagnosticEvidence] = []
        for (payloadIndex, payload) in payloads.enumerated() {
            let at = timestamp(payload.timeStampEnd)
            let window = max(0, min(7 * 24 * 60 * 60 * 1_000,
                                    payload.timeStampEnd.timeIntervalSince(payload.timeStampBegin) * 1_000))
            for (index, diagnostic) in (payload.crashDiagnostics ?? []).enumerated() {
                let relation = releaseRelation(diagnostic.applicationVersion)
                result.append(NativeDiagnosticEvidence(ref: reference(kind: "crash", at: at,
                                                                       discriminator: "\(payloadIndex):\(index)"),
                                                       at: at, kind: "native.crash", reason: "process_exit",
                                                       windowMs: window, releaseRelation: relation))
            }
            for (index, diagnostic) in (payload.hangDiagnostics ?? []).enumerated() {
                let duration = diagnostic.hangDuration.converted(to: .milliseconds).value
                guard duration.isFinite, (0 ... 86_400_000).contains(duration) else { continue }
                result.append(NativeDiagnosticEvidence(ref: reference(kind: "hang", at: at,
                                                                       discriminator: "\(payloadIndex):\(index):\(duration)"),
                                                       at: at, kind: "native.hang", reason: "unresponsive",
                                                       windowMs: window, releaseRelation: releaseRelation(diagnostic.applicationVersion),
                                                       durationMs: duration))
            }
        }
        return result
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static func releaseRelation(_ version: String) -> String {
        let current = [Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
                       Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String].compactMap { $0 }
        return current.contains(version) ? "current" : "other_or_unknown"
    }

    private static func reference(kind: String, at: String, discriminator: String) -> String {
        let digest = SHA256.hash(data: Data("\(kind)\u{0}\(at)\u{0}\(discriminator)".utf8))
        return "diagnostic:v1:native:" + digest.prefix(12).map { String(format: "%02x", $0) }.joined()
    }
}
