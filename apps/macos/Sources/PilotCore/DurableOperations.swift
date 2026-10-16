import CryptoKit
import Darwin
import Foundation

public struct DurableOperation: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let operationId: String
    public let producerId: String
    public let sequence: Int
    public let origin: HostRef
    public let destination: HostRef
    public let kind: String
    public let targetId: String
    /// Exact UTF-8 JSON bytes, not a reserialized mutable payload.
    public let payload: String
    public let payloadHash: String
    public let bindingId: String?
    public let bindingGeneration: UInt64?
}

public struct OperationReceipt: Codable, Equatable, Sendable {
    public let operationId: String
    public let payloadHash: String
    public let destination: HostRef
    public let targetId: String
    public let state: State
    public let result: JSONValue?
    public let reason: String?
    public enum State: String, Codable, Sendable { case pending, accepted, rejected }

    public func validate(_ operation: DurableOperation) throws {
        guard operationId == operation.operationId, payloadHash == operation.payloadHash,
              destination == operation.destination, targetId == operation.targetId else {
            throw HostRoutingError.identityChanged
        }
    }
}

public enum OperationDelivery: Equatable, Sendable {
    case unknown
    case receipt(OperationReceipt)
}

/// Immutable intents for UI sends/creates. This is NOT an offline chat-send queue.
/// Reserve only after availability checks. Retain until the consumer durably adopts the receipt
/// and clears its owning draft/attachments. Matching retries find the same intent after relaunch.
public actor OperationOutbox {
    private struct Counter: Codable { var producerId: String; var nextSequence: Int }
    private let directory: URL
    public init(directory: URL) { self.directory = directory }

    /// Read-only recovery inventory. Never executes, expires or silently reassigns an intent.
    public func pending(destination: HostRef? = nil) throws -> [DurableOperation] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey])
            .filter { $0.lastPathComponent != "counter.json" && $0.pathExtension == "json" }
        guard files.count <= 512 else { throw CocoaError(.fileReadTooLarge) }
        return try files.map { file in
            guard (try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 512 * 1024 else {
                throw CocoaError(.fileReadTooLarge)
            }
            let operation = try JSONDecoder().decode(DurableOperation.self, from: Data(contentsOf: file))
            guard operation.schemaVersion == 1, hash(Data(operation.payload.utf8)) == operation.payloadHash else {
                throw HostRoutingError.invalidReference
            }
            return operation
        }.filter { destination == nil || $0.destination == destination }
            .sorted { $0.sequence < $1.sequence }
    }

    public func contains(_ operation: DurableOperation) throws -> Bool {
        let key = hash(try encode([operation.origin.hostId, operation.origin.daemonId, operation.origin.lineageId,
            operation.destination.hostId, operation.destination.daemonId, operation.destination.lineageId,
            operation.kind, operation.targetId, operation.payloadHash]))
        // Creates reserve with an empty target selector, then allocate the immutable target ID.
        let createKey = hash(try encode([operation.origin.hostId, operation.origin.daemonId, operation.origin.lineageId,
            operation.destination.hostId, operation.destination.daemonId, operation.destination.lineageId,
            operation.kind, "", operation.payloadHash]))
        for name in [key, createKey] {
            let url = directory.appendingPathComponent(name + ".json")
            if FileManager.default.fileExists(atPath: url.path),
               try JSONDecoder().decode(DurableOperation.self, from: Data(contentsOf: url)) == operation { return true }
        }
        return false
    }

    private func hash(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    private func encode<Value: Encodable>(_ value: Value) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(value)
    }
    private func write<Value: Encodable>(_ value: Value, to url: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        let temp = directory.appendingPathComponent(UUID().uuidString + ".tmp")
        defer { try? FileManager.default.removeItem(at: temp) }
        try encode(value).write(to: temp, options: [.withoutOverwriting])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temp.path)
        let file = try FileHandle(forWritingTo: temp)
        do { try file.synchronize(); try file.close() } catch { try? file.close(); throw error }
        guard rename(temp.path, url.path) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let fd = open(directory.path, O_RDONLY)
        guard fd >= 0 else { throw POSIXError(.EIO) }
        defer { close(fd) }
        guard fsync(fd) == 0 else { throw POSIXError(.EIO) }
    }
    public func reserve<Payload: Encodable & Sendable>(
        kind: String, targetId: String?, payload: Payload, origin: HostRef, destination: HostRef
    ) throws -> DurableOperation {
        let bytes = try encode(payload)
        guard bytes.count <= 64 * 1024 else { throw CocoaError(.fileWriteFileExists) }
        let digest = hash(bytes)
        let key = hash(try encode([origin.hostId, origin.daemonId, origin.lineageId,
                                   destination.hostId, destination.daemonId, destination.lineageId,
                                   kind, targetId ?? "", digest]))
        let url = directory.appendingPathComponent(key + ".json")
        if FileManager.default.fileExists(atPath: url.path) {
            return try JSONDecoder().decode(DurableOperation.self, from: Data(contentsOf: url))
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        let files = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        guard files.count < 512 else { throw CocoaError(.fileWriteOutOfSpace) }
        let counterURL = directory.appendingPathComponent("counter.json")
        var counter: Counter
        if FileManager.default.fileExists(atPath: counterURL.path) {
            counter = try JSONDecoder().decode(Counter.self, from: Data(contentsOf: counterURL))
        } else { counter = Counter(producerId: UUID().uuidString, nextSequence: 1) }
        guard counter.nextSequence < 9_007_199_254_740_991 else { throw CocoaError(.fileWriteOutOfSpace) }
        let sequence = counter.nextSequence
        counter.nextSequence += 1
        try write(counter, to: counterURL)
        let operation = DurableOperation(schemaVersion: 1, operationId: UUID().uuidString,
            producerId: counter.producerId, sequence: sequence, origin: origin, destination: destination,
            kind: kind, targetId: targetId ?? UUID().uuidString, payload: String(decoding: bytes, as: UTF8.self),
            payloadHash: digest, bindingId: nil, bindingGeneration: nil)
        try write(operation, to: url)
        return operation
    }

    /// Call only AFTER the owning draft/attachment state has durably incorporated the receipt.
    public func acknowledge(_ operation: DurableOperation, receipt: OperationReceipt) throws {
        try receipt.validate(operation)
        guard receipt.state != .pending else { throw HostRoutingError.invalidReference }
        for file in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            where file.lastPathComponent != "counter.json" && file.pathExtension == "json" {
            let existing = try JSONDecoder().decode(DurableOperation.self, from: Data(contentsOf: file))
            if existing == operation { try FileManager.default.removeItem(at: file); return }
        }
    }
}
