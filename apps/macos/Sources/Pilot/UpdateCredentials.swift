import Foundation
import PilotCore
import Security

enum UpdateCredentials {
    @MainActor
    static func localGitHubToken() async -> String? {
        let environment = try? await AppModel.shared.daemon.loginShellEnvironment(requiresNode: false, timeout: 2)
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let path = [environment?.path ?? ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin",
                    "\(home)/.local/share/mise/shims", "/opt/homebrew/bin", "/usr/local/bin"].joined(separator: ":")
        guard let executable = path.split(separator: ":").filter({ $0.hasPrefix("/") }).map({ URL(filePath: "\($0)/gh") })
            .first(where: { FileManager.default.isExecutableFile(atPath: $0.path) })
        else { return nil }
        return await GitHubTokenCommand.read(executable: executable, path: path)
    }

    private static let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.babariviere.pilot.updates",
        kSecAttrAccount as String: "github-token",
    ]

    static func read() throws -> String? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data, let token = String(data: data, encoding: .utf8) else {
            throw credentialError()
        }
        return token
    }

    static func save(_ token: String) throws {
        let attributes: [String: Any] = [kSecValueData as String: Data(token.utf8)]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = query.merging(attributes) { _, value in value }
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw credentialError() }
    }

    static func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw credentialError() }
    }

    private static func credentialError() -> NSError {
        NSError(domain: "PilotUpdates", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not access update credentials in Keychain."])
    }
}
