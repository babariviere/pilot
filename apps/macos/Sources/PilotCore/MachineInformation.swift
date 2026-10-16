import Foundation

/// GET /api/machine. Observations at checkedAt, not a live monitoring feed. Nil is unavailable.
public struct MachineInformation: Codable, Equatable, Sendable {
    public struct Runtime: Codable, Equatable, Sendable {
        public let state: String
        public let version: String
        public let nodeVersion: String
    }
    public struct Service: Codable, Equatable, Sendable {
        public let state: String
    }
    public struct Disk: Codable, Equatable, Sendable {
        public let scope: String
        public let totalBytes: Double?
        public let availableBytes: Double?
    }
    public let checkedAt: Double
    public let runtime: Runtime
    public let service: Service
    public let os: String?
    public let kernel: String?
    public let architecture: String?
    public let cpuModel: String?
    public let logicalCpuCount: Int?
    public let memoryTotalBytes: Double?
    public let disk: Disk
}
