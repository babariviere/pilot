import AppKit
import Combine
import Foundation
import PilotCore
import Sparkle
import SwiftUI

/// GitHub Releases needs an asynchronous lookup before Sparkle can fetch its authenticated appcast.
/// We own the hourly schedule, leaving Sparkle's built-in scheduler disabled to avoid stale asset IDs.
@MainActor
final class AppUpdater: NSObject, ObservableObject, @preconcurrency SPUUpdaterDelegate {
    static let shared = AppUpdater()

    @Published private(set) var authenticated = false
    @Published private(set) var accessSource: UpdateAccessSource?
    @Published private(set) var checking = false
    @Published private(set) var sessionInProgress = false
    @Published private(set) var waitingToInstall = false
    @Published private(set) var status = "Looking for local GitHub CLI authentication…"
    @Published var automaticChecks = UserDefaults.standard.object(forKey: "PilotAutomaticUpdates") as? Bool ?? true {
        didSet { UserDefaults.standard.set(automaticChecks, forKey: "PilotAutomaticUpdates") }
    }

    let repository = (Bundle.main.object(forInfoDictionaryKey: "PilotUpdateRepository") as? String).flatMap(UpdateRepository.init)
    private var controller: SPUStandardUpdaterController?
    private var observation: AnyCancellable?
    private var token: String?
    private var feedURL: URL?
    private var archiveURL: URL?
    private var installTask: Task<Void, Never>?
    private var started = false
    private var stoppedDaemonGeneration: Int?
    private var tokenPromptShown = false

    var configured: Bool {
        repository != nil && !(Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String ?? "").isEmpty
    }
    var canCheck: Bool { configured && credentialsEditable }
    var credentialsEditable: Bool {
        !checking && !sessionInProgress && controller?.updater.sessionInProgress != true && installTask == nil
    }

    func start() {
        guard !started else { return }
        started = true
        guard configured else {
            status = "Updates are available in configured release builds, not this development build."
            return
        }
        // Restore non-secret asset identities for Sparkle's already downloaded/installed state.
        for (key, isFeed) in [("PilotUpdateFeed", true), ("PilotUpdateArchive", false)] {
            if let value = UserDefaults.standard.string(forKey: key), let url = URL(string: value),
               repository?.permitsAssetURL(url) == true {
                if isFeed { feedURL = url } else { archiveURL = url }
            }
        }
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        waitingToInstall = UserDefaults.standard.string(forKey: "PilotPreparedUpdateBuild") == build
        if !waitingToInstall { UserDefaults.standard.removeObject(forKey: "PilotPreparedUpdateBuild") }
        checking = true
        Task { [weak self] in
            if let self {
                await self.loadAccess()
                self.startController()
                self.checking = false
                if self.waitingToInstall {
                    // A verified cached installer can resume offline or after token expiry.
                    self.status = "Resuming a downloaded update…"
                    self.controller?.updater.checkForUpdatesInBackground()
                } else if !self.authenticated && !self.automaticChecks {
                    self.requestToken(userInitiated: false)
                }
            }
            while !Task.isCancelled {
                if let self, self.automaticChecks { await self.check(userInitiated: false) }
                try? await Task.sleep(for: .seconds(3600))
            }
        }
    }

    func saveToken(_ value: String) async -> Bool {
        guard configured, credentialsEditable else { return false }
        guard let candidate = GitHubTokenCommand.validToken(value) else {
            status = "Enter a valid GitHub token."
            return false
        }
        checking = true
        defer { checking = false }
        do {
            _ = try await latestRelease(token: candidate)
            try UpdateCredentials.save(candidate)
            token = candidate
            authenticated = true
            accessSource = .savedToken
            status = "GitHub access saved in Keychain."
            Task { await self.check(userInitiated: false) }
            return true
        } catch {
            status = error.localizedDescription
            return false
        }
    }

    func removeToken() {
        guard credentialsEditable else { return }
        do {
            try UpdateCredentials.remove()
            if accessSource != .githubCLI {
                token = nil
                controller?.updater.httpHeaders = nil
                authenticated = false
                accessSource = nil
            }
            status = accessSource == .githubCLI ? "Saved token removed. Still using local gh authentication." :
                "Saved token removed. Local gh authentication will be tried on the next check."
        } catch { status = error.localizedDescription }
    }

    func check(userInitiated: Bool = true) async {
        guard canCheck, let repository else { return }
        checking = true
        var askForToken = false
        defer {
            checking = false
            if askForToken { requestToken(userInitiated: userInitiated) }
        }
        // Re-read gh on each check so gh auth login/logout and token rotation take effect.
        await loadAccess()
        guard token != nil else { askForToken = true; return }
        status = "Checking private releases…"
        do {
            let release = try await releaseWithAccess()
            guard let assets = release.updateAssets() else {
                throw updateError("The latest release does not contain a complete Apple Silicon update.")
            }
            feedURL = repository.assetURL(id: assets.feed.id)
            archiveURL = repository.assetURL(id: assets.archive.id)
            UserDefaults.standard.set(feedURL?.absoluteString, forKey: "PilotUpdateFeed")
            UserDefaults.standard.set(archiveURL?.absoluteString, forKey: "PilotUpdateArchive")
            controller?.updater.httpHeaders = token.map { ["Authorization": "Bearer \($0)", "Accept": "application/octet-stream"] }
            if userInitiated { controller?.updater.checkForUpdates() }
            else { controller?.updater.checkForUpdatesInBackground() }
        } catch {
            status = error.localizedDescription
            askForToken = authorizationFailed(error) && token == nil
            // A latest-release lookup is not necessary to resume Sparkle's cached download.
            if feedURL != nil && (token != nil || waitingToInstall) {
                if userInitiated { controller?.updater.checkForUpdates() }
                else { controller?.updater.checkForUpdatesInBackground() }
            }
        }
    }

    private func loadAccess() async {
        do {
            let access = try await UpdateAccessResolver.resolve(
                cliToken: { await UpdateCredentials.localGitHubToken() }, savedToken: { try UpdateCredentials.read() }
            )
            token = access?.token
            accessSource = access?.source
            authenticated = access != nil
            status = accessSource == .githubCLI ? "Using local gh authentication." :
                (authenticated ? "Using the token saved in Keychain." : "Sign in with gh auth login, or enter a GitHub token.")
        } catch {
            token = nil
            accessSource = nil
            authenticated = false
            status = error.localizedDescription
        }
        controller?.updater.httpHeaders = token.map { ["Authorization": "Bearer \($0)", "Accept": "application/octet-stream"] }
    }

    private func releaseWithAccess() async throws -> UpdateRelease {
        guard let candidate = token else { throw updateError("GitHub authentication is required.") }
        do { return try await latestRelease(token: candidate) }
        catch {
            guard authorizationFailed(error) else { throw error }
            let usedCLI = accessSource == .githubCLI
            token = nil
            accessSource = nil
            authenticated = false
            controller?.updater.httpHeaders = nil
            // gh can return an expired token or one without private-repository access.
            // Allow a validated manual fallback without changing the user's gh login.
            if usedCLI, let saved = GitHubTokenCommand.validToken(try UpdateCredentials.read()), saved != candidate {
                let release = try await latestRelease(token: saved)
                token = saved
                accessSource = .savedToken
                authenticated = true
                return release
            }
            throw error
        }
    }

    private func authorizationFailed(_ error: Error) -> Bool {
        guard let status = (error as NSError).userInfo["GitHubHTTPStatus"] as? Int else { return false }
        return [401, 403, 404].contains(status)
    }

    private func requestToken(userInitiated: Bool) {
        guard !waitingToInstall, credentialsEditable, userInitiated || !tokenPromptShown else { return }
        tokenPromptShown = true
        let alert = NSAlert()
        alert.messageText = "GitHub access required for private updates"
        alert.informativeText = "Pilot could not use local gh authentication for this repository. Run gh auth login and retry, or enter a GitHub token with Contents: Read-only access. Manual tokens are saved in Keychain."
        let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
        field.placeholderString = "GitHub token"
        alert.accessoryView = field
        alert.addButton(withTitle: "Save Token")
        alert.addButton(withTitle: "Not Now")
        alert.window.initialFirstResponder = field
        let response = alert.runModal()
        let candidate = field.stringValue
        field.stringValue = ""
        if response == .alertFirstButtonReturn {
            Task {
                if !(await self.saveToken(candidate)) {
                    let failure = NSAlert()
                    failure.messageText = "Could not save GitHub access"
                    failure.informativeText = self.status + " You can retry in Settings > Updates."
                    failure.runModal()
                }
            }
        }
    }

    private func startController() {
        guard controller == nil else { return }
        let controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)
        self.controller = controller
        controller.updater.httpHeaders = token.map { ["Authorization": "Bearer \($0)", "Accept": "application/octet-stream"] }
        observation = controller.updater.publisher(for: \.sessionInProgress)
            .receive(on: RunLoop.main)
            .sink { [weak self] value in self?.sessionInProgress = value }
        controller.startUpdater()
    }

    private func latestRelease(token: String) async throws -> UpdateRelease {
        guard let repository else { throw updateError("No update repository configured.") }
        var request = URLRequest(url: repository.latestReleaseURL)
        request.timeoutInterval = 30
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw updateError("GitHub returned an invalid response.") }
        switch response.statusCode {
        case 200: return try JSONDecoder().decode(UpdateRelease.self, from: data)
        case 401, 403: throw updateError("GitHub access denied. Check the token's repository access, Contents read permission, and expiry.", httpStatus: response.statusCode)
        case 404: throw updateError("No release found, or the token cannot access this private repository.", httpStatus: response.statusCode)
        default: throw updateError("GitHub update check failed (HTTP \(response.statusCode)).")
        }
    }

    // Sparkle never receives browser download URLs, credentials in URLs, or external release notes.
    func feedURLString(for updater: SPUUpdater) -> String? {
        // This bootstrap URL makes configuration valid before discovery. It is not an appcast:
        // no update can be offered from it, but cached installers can resume without a network feed.
        (feedURL ?? repository?.latestReleaseURL)?.absoluteString
    }

    func updater(_ updater: SPUUpdater, mayPerform updateCheck: SPUUpdateCheck) throws {
        guard waitingToInstall || (token != nil && feedURL != nil && archiveURL != nil) else {
            throw updateError("GitHub update access is not ready.")
        }
    }

    func updater(_ updater: SPUUpdater, shouldProceedWithUpdate item: SUAppcastItem, updateCheck: SPUUpdateCheck) throws {
        guard item.fileURL == archiveURL, item.deltaUpdates?.isEmpty != false else {
            throw updateError("The update feed references an unexpected download.")
        }
    }

    func updater(_ updater: SPUUpdater, willDownloadUpdate item: SUAppcastItem, with request: NSMutableURLRequest) {
        request.setValue(nil, forHTTPHeaderField: "Authorization")
        if let url = request.url, url == archiveURL, repository?.permitsAssetURL(url) == true, let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
        }
    }

    func updater(_ updater: SPUUpdater, shouldDownloadReleaseNotesForUpdate item: SUAppcastItem) -> Bool { false }

    func updaterDidNotFindUpdate(_ updater: SPUUpdater) { status = "Pilot is up to date." }

    func updater(_ updater: SPUUpdater, willExtractUpdate item: SUAppcastItem) {
        // A manually downloaded installer can also install on ordinary quit, before the user
        // presses Install and Relaunch. Cover that window, not just automatic installations.
        waitingToInstall = true
        UserDefaults.standard.set(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion"), forKey: "PilotPreparedUpdateBuild")
    }

    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        status = "Update failed: \(error.localizedDescription)"
        if waitingToInstall {
            // Sparkle disconnecting from a prepared installer does not cancel installation on
            // quit. Keep the marker and safety gate, and allow retrying from Settings.
            status += " Retry the update in Settings. Quitting still requires an idle daemon shutdown."
        }
        installTask?.cancel()
    }

    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem, immediateInstallationBlock handler: @escaping () -> Void) -> Bool {
        installWhenIdle(handler)
        return true
    }

    func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem, untilInvokingBlock handler: @escaping () -> Void) -> Bool {
        if daemonIsStoppedForUpdate { return false }
        installWhenIdle(handler)
        return true
    }

    private func installWhenIdle(_ handler: @escaping () -> Void) {
        if daemonIsStoppedForUpdate { handler(); return }
        guard installTask == nil else { return }
        waitingToInstall = true
        status = "Update downloaded. Waiting for agents to finish. Terminal shells will close on installation."
        installTask = Task {
            // Keep this task's slot until an uncancelled shutdown verification finishes. No
            // retry may replace it and no older task can clear a newer continuation's slot.
            defer { installTask = nil }
            while !Task.isCancelled {
                var retryDelay = 15
                do {
                    let daemon = AppModel.shared.daemon
                    // Check REST, not the possibly stale WebSocket list. Fail closed if unreachable.
                    if try await daemon.stopIfIdleForUpdate() {
                        stoppedDaemonGeneration = daemon.lifecycleGeneration
                        if Task.isCancelled {
                            // A prepared helper can still install on quit after an abort. Do not
                            // restart code inside the bundle it may replace; a retry can resume.
                            return
                        }
                        status = "Installing update…"
                        handler()
                        return
                    }
                } catch {
                    if Task.isCancelled { return }
                    stoppedDaemonGeneration = nil
                    status = "Update waiting: \(error.localizedDescription)"
                    // If shutdown failed after a successful prepare, let the 30-second lease
                    // expire before retrying. Never renew a failed shutdown into a work freeze.
                    retryDelay = 60
                }
                try? await Task.sleep(for: .seconds(retryDelay))
            }
        }
    }

    /// Sparkle may install on ordinary quit too. Do not let it replace a live daemon's runtime.
    func shouldDelayTermination() -> Bool {
        guard waitingToInstall && !daemonIsStoppedForUpdate else { return false }
        // Ordinary quit from the manual Ready to Install dialog also needs a safe daemon stop.
        // When an automatic/manual install handler already exists it remains responsible instead.
        if installTask == nil { installWhenIdle { NSApp.terminate(nil) } }
        return true
    }

    private var daemonIsStoppedForUpdate: Bool {
        let daemon = AppModel.shared.daemon
        return stoppedDaemonGeneration == daemon.lifecycleGeneration && daemon.status == .stopped && !daemon.lifecycleBusy
    }

    private func updateError(_ message: String, httpStatus: Int? = nil) -> NSError {
        var info: [String: Any] = [NSLocalizedDescriptionKey: message]
        if let httpStatus { info["GitHubHTTPStatus"] = httpStatus }
        return NSError(domain: "PilotUpdates", code: 2, userInfo: info)
    }
}

@MainActor
private final class UpdateTokenEditor: ObservableObject {
    @Published var token = ""
}

struct UpdateSettings: View {
    @ObservedObject private var updater = AppUpdater.shared
    @StateObject private var editor = UpdateTokenEditor()

    var body: some View {
        Form {
            Section("Private GitHub releases") {
                Text(updater.repository?.name ?? "Development build")
                Text("Pilot first uses gh auth token from your login-shell PATH. If gh is unavailable or cannot access this repository, enter a fine-grained token with Contents: Read-only access. Only manually entered tokens are stored in Keychain.")
                    .font(.caption).foregroundStyle(.secondary)
                if updater.accessSource == .githubCLI {
                    Text("Using local gh authentication.").font(.caption).foregroundStyle(.secondary)
                }
                SecureField("GitHub token", text: $editor.token)
                    .disabled(!updater.configured || !updater.credentialsEditable)
                HStack {
                    Button("Save Access") {
                        Task { if await updater.saveToken(editor.token) { editor.token = "" } }
                    }.disabled(editor.token.isEmpty || !updater.configured || !updater.credentialsEditable)
                    Button("Remove Saved Token") { updater.removeToken() }
                        .disabled(!updater.configured || !updater.credentialsEditable)
                }
            }
            Section("Updates") {
                Toggle("Check automatically every hour", isOn: $updater.automaticChecks)
                    .disabled(!updater.configured)
                Text("Updates install when agents are idle and restart Pilot and pilotd. Terminal shells close. An update waiting to install may delay quitting Pilot until agents finish.")
                    .font(.caption).foregroundStyle(.secondary)
                Text(updater.status).font(.caption).textSelection(.enabled)
                Button("Check for Updates…") { Task { await updater.check() } }.disabled(!updater.canCheck)
            }
        }
        .formStyle(.grouped)
    }
}
