import Foundation
import PilotCore
import Testing
@testable import Pilot

@Test func nativeAppLogProducerFeedsProductionReaderWithoutPayloads() async throws {
    let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let logger = NativeAppLog(directory: root)
    logger.setHost(HostRef(hostId: "local", daemonId: "fixture-daemon", lineageId: "fixture-lineage"))
    logger.setEnabled(true)
    logger.record(.transportFailed, error: NSError(domain: NSURLErrorDomain, code: -1001,
        userInfo: [NSLocalizedDescriptionKey: "password=private-payload", "payload": "private-payload"]))
    await logger.flush()
    #expect(!logger.writeFailed)
    let bytes = try String(contentsOf: root.appendingPathComponent("app.jsonl"), encoding: .utf8)
    #expect(!bytes.contains("private-payload") && bytes.contains("-1001"))
    let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../..").standardizedFileURL
    // Use the existing bounded child runner, not an unbounded wait on the test executor or a full pipe.
    let captured = await UpdateCommand.output(executable: URL(fileURLWithPath: "/usr/bin/env"),
        arguments: ["node", repository.appendingPathComponent("packages/daemon/src/native-app-log.fixture.ts").path, root.path],
        path: ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin", timeout: 15, maxBytes: 16 * 1024)
    let result = try #require(captured, "The production reader probe failed or exceeded its 15-second bound.")
    #expect(result.contains("producer-reader-ok"))
    logger.setEnabled(false)
    try await logger.clear()
    logger.record(.repairArchiveFailed)
    await logger.flush()
    #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("app.jsonl").path))
}

@Test func nativeAppLogRotationExpiryAndUnsafeSourceFailureAreBounded() async throws {
    let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let logger = NativeAppLog(directory: root)
    logger.setHost(HostRef(hostId: "local", daemonId: "fixture-daemon", lineageId: "fixture-lineage"))
    logger.setEnabled(true)
    logger.record(.appStarted, now: Date().addingTimeInterval(-NativeAppLog.retention - 1))
    await logger.flush()
    logger.record(.repairStarted)
    await logger.flush()
    let current = root.appendingPathComponent("app.jsonl")
    let line = try Data(contentsOf: current)
    var filled = Data()
    for _ in 0..<(NativeAppLog.segmentBytes / line.count) { filled.append(line) }
    try filled.write(to: current)
    logger.record(.repairStarted)
    await logger.flush()
    for name in ["app.jsonl", "app.jsonl.1"] {
        let file = root.appendingPathComponent(name)
        let values = try file.resourceValues(forKeys: [.fileSizeKey])
        #expect((values.fileSize ?? 0) <= NativeAppLog.segmentBytes)
        #expect(!(try String(contentsOf: file, encoding: .utf8)).contains("app_started"))
    }
    logger.record(.repairStarted)
    try await logger.clear() // Drains older admitted writes; their generation cannot resurrect cleared data.
    await logger.flush()
    #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("app.jsonl").path))
    let outside = root.appendingPathComponent("outside")
    try Data("untouched".utf8).write(to: outside)
    try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("app.jsonl"), withDestinationURL: outside)
    logger.record(.repairStarted)
    await logger.flush()
    #expect(logger.writeFailed)
    #expect(try String(contentsOf: outside, encoding: .utf8) == "untouched")
}
