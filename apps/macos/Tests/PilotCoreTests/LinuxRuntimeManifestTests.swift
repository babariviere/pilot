import CryptoKit
import Foundation
import Testing
@testable import PilotCore

struct LinuxRuntimeManifestTests {
    private func fixture() throws -> (Data, Data, Data) {
        let bytes = Data("production archive".utf8)
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let json = #"{"schemaVersion":1,"platform":"linux","arch":"x64","version":"1.38.0","tag":"v1.38.0","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","protocolVersion":1,"minimumClientProtocolVersion":1,"minimumGlibc":"2.28","minimumGlibcxx":"3.4.21","node":{"version":"24.21.0","modules":"137"},"archive":{"name":"Pilot-linux-x64.tar.gz","size":18,"sha256":"HASH"}}"#
        let data = Data(json.replacingOccurrences(of: "HASH", with: digest).utf8)
        let key = Curve25519.Signing.PrivateKey()
        return (data, try key.signature(for: data), key.publicKey.rawRepresentation)
    }

    @Test func signatureArchiveAndReplayValidation() throws {
        let (data, signature, key) = try fixture()
        let manifest = try LinuxRuntimeManifest.verified(data: data, signature: signature, publicKey: key, releaseTag: "v1.38.0", expectedVersion: "1.38.0")
        try manifest.verifyArchive(Data("production archive".utf8))
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        try Data("production archive".utf8).write(to: file)
        try manifest.verifyArchive(at: file)
        try Data("production corrupt".utf8).write(to: file)
        #expect(throws: Error.self) { try manifest.verifyArchive(at: file) }
        #expect(throws: Error.self) { try manifest.verifyArchive(Data("production corrupt".utf8)) }
        #expect(throws: Error.self) { try LinuxRuntimeManifest.verified(data: data + Data(" ".utf8), signature: signature, publicKey: key, releaseTag: "v1.38.0", expectedVersion: "1.38.0") }
        #expect(throws: Error.self) { try LinuxRuntimeManifest.verified(data: data, signature: signature, publicKey: Curve25519.Signing.PrivateKey().publicKey.rawRepresentation, releaseTag: "v1.38.0", expectedVersion: "1.38.0") }
        #expect(throws: Error.self) { try LinuxRuntimeManifest.verified(data: data, signature: signature, publicKey: key, releaseTag: "v1.39.0", expectedVersion: "1.38.0") }
        #expect(throws: Error.self) { try LinuxRuntimeManifest.verified(data: data, signature: signature, publicKey: key, releaseTag: "v1.38.0", expectedVersion: "1.39.0") }
        #expect(throws: Error.self) { try LinuxRuntimeManifest.verified(data: data, signature: signature, publicKey: key, releaseTag: "v1.38.0", expectedVersion: "1.38.0", clientProtocolVersion: 2) }
    }

    @Test func onlyCompleteStableAssetSets() throws {
        let release = try JSONDecoder().decode(UpdateRelease.self, from: Data(#"{"draft":false,"prerelease":false,"assets":[{"id":1,"name":"runtime-manifest.json","state":"uploaded"},{"id":2,"name":"runtime-manifest.json.sig","state":"uploaded"},{"id":3,"name":"Pilot-linux-x64.tar.gz","state":"uploaded"}]}"#.utf8))
        #expect(release.linuxRuntimeAssets()?.archive.id == 3)
        let incomplete = try JSONDecoder().decode(UpdateRelease.self, from: Data(#"{"draft":false,"prerelease":false,"assets":[]}"#.utf8))
        #expect(incomplete.linuxRuntimeAssets() == nil)
    }
}
