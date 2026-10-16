import CryptoKit
import Foundation
import Testing
@testable import PilotCore

struct LinuxSSHBootstrapTests {
    private func package(at url: URL) async throws -> LinuxRuntimePackage {
        let bytes = Data("archive".utf8)
        try bytes.write(to: url)
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let manifest = Data(#"{"schemaVersion":1,"platform":"linux","arch":"x64","version":"1.38.0","tag":"v1.38.0","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","protocolVersion":1,"minimumClientProtocolVersion":1,"minimumGlibc":"2.28","minimumGlibcxx":"3.4.21","node":{"version":"24.21.0","modules":"137"},"archive":{"name":"Pilot-linux-x64.tar.gz","size":7,"sha256":"HASH"}}"#.replacingOccurrences(of: "HASH", with: digest).utf8)
        let key = Curve25519.Signing.PrivateKey()
        return try await LinuxRuntimePackage.verified(manifest: manifest, signature: key.signature(for: manifest),
            pinnedPublicKey: key.publicKey.rawRepresentation, releaseTag: "v1.38.0", expectedVersion: "1.38.0", archiveURL: url)
    }

    @Test func commandPreservesSSHPolicyAndContainsNoSecretsOrPrivilegeExecution() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        let package = try await package(at: url)
        let configuration = try SSHConnectionConfiguration(alias: "fixture-host")
        let script = try LinuxSSHBootstrap.scriptSource()
        #expect(script.contains("fcntl.LOCK_EX"))
        let arguments = try LinuxSSHBootstrap.commandArguments(configuration: configuration, package: package,
                                                               pinnedHost: nil, script: script)
        #expect(arguments.contains("StrictHostKeyChecking=yes"))
        #expect(arguments.contains("BatchMode=yes"))
        #expect(arguments.contains("ClearAllForwardings=yes"))
        #expect(arguments.contains("ForwardAgent=no"))
        #expect(arguments.contains("none"))
        #expect(!arguments.contains("-N"))
        #expect(arguments[arguments.count - 2] == "fixture-host")
        let remote = try #require(arguments.last)
        #expect(remote.contains(package.manifest.archive.sha256))
        #expect(remote.contains("for manager in dnf apt-get yum"))
        #expect(!remote.contains(url.path))
        #expect(!remote.contains("Bearer"))
        #expect(!remote.contains("sudo loginctl"))
    }

    @Test func helloRequiresIdentityVersionPlatformAndSeparateIsolationCapability() throws {
        let host = HostRef(hostId: "fixture", daemonId: "daemon", lineageId: "lineage")
        let json = #"{"daemonId":"daemon","lineageId":"lineage","daemonVersion":"1.38.0","protocolVersion":1,"minimumClientProtocolVersion":1,"platform":"linux","arch":"x64","capabilities":{"powerManagement":false,"systemSleepEvents":false,"swiftUIArtifacts":false,"coordinatorIsolation":true,"independentExecution":true}}"#
        try LinuxSSHBootstrap.validateHello(Data(json.utf8), host: host, version: "1.38.0")
        for (from, to) in [("\"coordinatorIsolation\":true", "\"coordinatorIsolation\":false"),
                           ("\"independentExecution\":true", "\"independentExecution\":false"),
                           ("\"daemon\"", "\"other\""), ("\"lineage\"", "\"other\""),
                           ("1.38.0", "1.37.0"), ("linux", "darwin"), ("x64", "arm64"),
                           ("\"minimumClientProtocolVersion\":1", "\"minimumClientProtocolVersion\":2")] {
            let changed = Data(json.replacingOccurrences(of: from, with: to).utf8)
            #expect(throws: Error.self) { try LinuxSSHBootstrap.validateHello(changed, host: host, version: "1.38.0") }
        }
    }

    @Test func assetAndTrustBlockersPrecedeSSH() async throws {
        let release = try JSONDecoder().decode(UpdateRelease.self, from: Data(#"{"draft":false,"prerelease":false,"assets":[]}"#.utf8))
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        await #expect(throws: Error.self) {
            _ = try await LinuxRuntimePackage.download(release: release, repository: UpdateRepository("fixture/repo")!, token: "",
                releaseTag: "v1.38.0", expectedVersion: "1.38.0", bundle: Bundle(for: BundleMarker.self), to: url)
        }
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }

    private final class BundleMarker: NSObject {}

    @Test func missingPythonDetectsDnfAndReturnsPlanWithoutExecutingIt() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let input = directory.appendingPathComponent("archive")
        let package = try await package(at: input)
        let dnf = directory.appendingPathComponent("dnf")
        try Data("#!/bin/sh\nexit 99\n".utf8).write(to: dnf)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dnf.path)
        let arguments = try LinuxSSHBootstrap.commandArguments(configuration: SSHConnectionConfiguration(alias: "fixture"),
            package: package, pinnedHost: nil, script: LinuxSSHBootstrap.scriptSource())
        let remote = try #require(arguments.last)
        let output = try await LinuxBootstrapSSH.run(arguments: ["-c", "PATH='\(directory.path)'; " + remote],
            input: input, executable: URL(fileURLWithPath: "/bin/sh"), timeout: 10)
        let object = try #require(JSONSerialization.jsonObject(with: output) as? [String: Any])
        #expect(object["code"] as? String == "python")
        let plan = try #require(object["plan"] as? [String: Any])
        #expect(plan["command"] as? [String] == ["sudo", "dnf", "install", "-y", "python3"])
    }

    @Test func localPackageMutationFailsBeforeSSH() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        let package = try await package(at: url)
        try Data("corrupt".utf8).write(to: url)
        await #expect(throws: Error.self) {
            _ = try await LinuxSSHBootstrap.install(configuration: SSHConnectionConfiguration(alias: "not-a-real-host"),
                                                     package: package, hostId: "fixture")
        }
    }

    @Test func updateRetainsExactSignedPackageAndPinnedHostWithoutSendingCredentials() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        let package = try await package(at: url)
        let host = HostRef(hostId: "fixture", daemonId: UUID().uuidString.lowercased(), lineageId: UUID().uuidString.lowercased())
        let id = UUID()
        let args = try LinuxSSHUpdate.commandArguments(configuration: SSHConnectionConfiguration(alias: "fixture"),
            package: package, host: host, id: id, script: LinuxSSHBootstrap.scriptSource())
        #expect(args.contains("StrictHostKeyChecking=yes"))
        #expect(args.contains("ForwardAgent=no"))
        let command = try #require(args.last)
        let encoded = try #require(command.components(separatedBy: " update '").last?.dropLast())
        let metadata = try #require(Data(base64Encoded: String(encoded)))
        let values = try #require(JSONSerialization.jsonObject(with: metadata) as? [String: String])
        #expect(values["id"] == id.uuidString.lowercased())
        #expect(values["daemonId"] == host.daemonId)
        #expect(values["lineageId"] == host.lineageId)
        #expect(values["manifest"] == package.manifestBytes.base64EncodedString())
        #expect(values["publicKey"] == package.publicKey.base64EncodedString())
        #expect(!command.contains(url.path))
        #expect(!command.contains("Bearer"))
        let changed = url
        try Data("changed".utf8).write(to: changed)
        await #expect(throws: Error.self) {
            _ = try await LinuxSSHUpdate.start(configuration: SSHConnectionConfiguration(alias: "not-a-real-host"),
                package: package, host: host, id: id)
        }
    }

    @Test func ownedSSHProcessStreamsInputBoundsOutputAndTimesOut() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let input = directory.appendingPathComponent("input")
        try Data("fixture".utf8).write(to: input)
        let success = try await LinuxBootstrapSSH.run(arguments: ["-c", "cat"], input: input,
                                                     executable: URL(fileURLWithPath: "/bin/sh"), timeout: 10)
        #expect(success == Data("fixture".utf8))
        await #expect(throws: Error.self) {
            _ = try await LinuxBootstrapSSH.run(arguments: ["-c", "exec /usr/bin/yes noisy"], input: input,
                                               executable: URL(fileURLWithPath: "/bin/sh"), timeout: 10)
        }
        await #expect(throws: Error.self) {
            _ = try await LinuxBootstrapSSH.run(arguments: ["-c", "exec /bin/sleep 30"], input: input,
                                               executable: URL(fileURLWithPath: "/bin/sh"), timeout: 0.2)
        }
    }
}
