import CryptoKit
import Foundation

/// Authenticated Linux package contract. Network/SSH setup remains outside this value type.
public struct LinuxRuntimeManifest: Decodable, Sendable {
    public struct Archive: Decodable, Sendable {
        public let name: String
        public let size: Int
        public let sha256: String
    }

    public struct Node: Decodable, Sendable {
        public let version: String
        public let modules: String
    }

    public let schemaVersion: Int
    public let platform: String
    public let arch: String
    public let version: String
    public let tag: String
    public let commit: String
    public let protocolVersion: Int
    public let minimumClientProtocolVersion: Int
    public let minimumGlibc: String
    public let node: Node
    public let archive: Archive

    public enum ValidationError: Error {
        case signature, incompatible, archive
    }

    /// The raw Ed25519 public key must come from the signed Mac bundle, not a downloaded asset.
    /// Match the authenticated GitHub release and this client version to prevent cross-release replay.
    public static func verified(
        data: Data, signature: Data, publicKey: Data,
        releaseTag: String, expectedVersion: String,
        clientProtocolVersion: Int = DaemonHello.clientProtocolVersion
    ) throws -> LinuxRuntimeManifest {
        guard data.count <= 65_536, signature.count == 64, publicKey.count == 32,
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey),
              key.isValidSignature(signature, for: data)
        else { throw ValidationError.signature }
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.schemaVersion == 1, value.platform == "linux", value.arch == "x64",
              value.version == expectedVersion, value.version.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression) != nil,
              value.tag == releaseTag, value.tag == "v\(value.version)",
              value.commit.range(of: #"^[a-f0-9]{40}$"#, options: .regularExpression) != nil,
              value.minimumClientProtocolVersion > 0,
              value.minimumClientProtocolVersion <= clientProtocolVersion, clientProtocolVersion <= value.protocolVersion,
              value.node.version.range(of: #"^24\.\d+\.\d+$"#, options: .regularExpression) != nil,
              value.node.modules.range(of: #"^\d+$"#, options: .regularExpression) != nil,
              value.minimumGlibc.range(of: #"^2\.\d+$"#, options: .regularExpression) != nil,
              value.archive.name == "Pilot-linux-x64.tar.gz", value.archive.size > 0, value.archive.size <= 536_870_912,
              value.archive.sha256.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil
        else { throw ValidationError.incompatible }
        return value
    }

    public func verifyArchive(_ data: Data) throws {
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard data.count == archive.size, hash == archive.sha256 else { throw ValidationError.archive }
    }
}

extension UpdateRelease {
    /// Credentials may only be sent to UpdateRepository.assetURL(id:), never an asset-supplied URL.
    public func linuxRuntimeAssets() -> (manifest: Asset, signature: Asset, archive: Asset)? {
        guard !draft, !prerelease else { return nil }
        func unique(_ name: String) -> Asset? {
            let matches = assets.filter { $0.name == name && $0.state == "uploaded" && $0.id > 0 }
            return matches.count == 1 ? matches[0] : nil
        }
        guard let manifest = unique("runtime-manifest.json"),
              let signature = unique("runtime-manifest.json.sig"),
              let archive = unique("Pilot-linux-x64.tar.gz") else { return nil }
        return (manifest, signature, archive)
    }
}
