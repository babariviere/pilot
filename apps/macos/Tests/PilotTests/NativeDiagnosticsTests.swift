import Foundation
import PilotCore
import Testing
@testable import Pilot

private func nativeEvidence(_ index: Int, at: Date, kind: String = "native.crash") -> NativeDiagnosticEvidence {
    let suffix = String(format: "%024x", index)
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return NativeDiagnosticEvidence(ref: "diagnostic:v1:native:\(suffix)", at: formatter.string(from: at),
                                    kind: kind, reason: kind == "native.hang" ? "unresponsive" : "process_exit",
                                    windowMs: 86_400_000, releaseRelation: "current",
                                    durationMs: kind == "native.hang" ? 2_000 : nil)
}

@Test func nativeArchiveKeepsOnlyClosedBoundedRecentEvidence() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let archive = NativeDiagnosticArchive(directory: directory)
    let now = Date(timeIntervalSince1970: 2_000_000_000)
    let observations = (0..<35).map { nativeEvidence($0, at: now.addingTimeInterval(Double($0))) }
    #expect(try await archive.append(observations, now: now.addingTimeInterval(35)))
    let batch = try await archive.snapshot(now: now.addingTimeInterval(35))
    #expect(batch.evidence.count == nativeDiagnosticLimit)
    #expect(batch.dropped == 3)
    #expect(batch.evidence.first?.ref.hasSuffix(String(format: "%024x", 34)) == true)
    #expect(batch.evidence.allSatisfy { $0.source == .os })
    let attributes = try FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent("native-diagnostics.json").path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
}

@Test func nativeArchiveExpiresOldEvidenceAndClearsItsPrivateFile() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let archive = NativeDiagnosticArchive(directory: directory)
    let now = Date(timeIntervalSince1970: 2_000_000_000)
    _ = try await archive.append([nativeEvidence(1, at: now.addingTimeInterval(-nativeDiagnosticRetention - 1)),
                                  nativeEvidence(2, at: now)], now: now)
    #expect(try await archive.snapshot(now: now).evidence.map(\.ref) == [nativeEvidence(2, at: now).ref])
    try await archive.clear()
    #expect(try await archive.snapshot(now: now).evidence.isEmpty)
}

@Test func nativeArchiveFailsClosedOnOpenFields() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appendingPathComponent("native-diagnostics.json")
    let evidence = nativeEvidence(1, at: Date(timeIntervalSince1970: 2_000_000_000))
    let encoded = try JSONEncoder().encode(NativeDiagnosticsBatch(evidence: [evidence], dropped: 0))
    var object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    var items = try #require(object["evidence"] as? [[String: Any]])
    items[0]["stack"] = "private stack"
    object["evidence"] = items
    try JSONSerialization.data(withJSONObject: object).write(to: file)
    let archive = NativeDiagnosticArchive(directory: directory)
    await #expect(throws: NativeDiagnosticArchiveError.self) { try await archive.snapshot() }
}
