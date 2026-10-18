import Combine
import PilotCore
import SwiftUI

@MainActor
struct GitHubSetupActions {
    var available: (HostRef) -> Bool
    var status: (HostRef) async throws -> GitHubSetupStatus
    var act: (HostRef, GitHubSetupAction) async throws -> GitHubSetupStatus
    static func live(_ hosts: HostClients) -> Self {
        Self(available: { hosts.available.contains($0) }, status: {
            try await hosts.githubRequest(on: $0, body: Optional<GitHubSetupAction>.none, method: "GET")
        }, act: { try await hosts.githubRequest(on: $0, body: $1) })
    }
}

@MainActor
final class GitHubSetupModel: ObservableObject {
    let host: HostRef
    private let actions: GitHubSetupActions
    @Published private(set) var status: GitHubSetupStatus?
    @Published private(set) var busy = false
    @Published private(set) var uncertain = false
    @Published private(set) var problem: String?
    private var generation = UUID()
    init(host: HostRef, actions: GitHubSetupActions) { self.host = host; self.actions = actions }
    func detach() { generation = UUID(); status = nil }
    func refresh() async {
        guard !busy, actions.available(host) else { return }
        busy = true; defer { busy = false }
        let fence = generation
        do {
            let value = try await actions.status(host)
            guard fence == generation, actions.available(host) else { return }
            status = value; uncertain = false; problem = nil
        } catch { if fence == generation { problem = "Could not check GitHub on this host. Reconnect and check again. Nothing was sent to Local." } }
    }
    /// The view passes the exact displayed snapshot after confirmation, never a message-supplied grant.
    func perform(_ action: String, approval: GitHubSetupStatus? = nil) async {
        guard !busy, !uncertain, actions.available(host) else { return }
        if ["approve_key", "revoke_key"].contains(action) {
            guard let approval, approval == status, approval.account != nil, approval.fingerprint != nil else { return }
        }
        busy = true; defer { busy = false }
        let fence = generation
        do {
            let value = try await actions.act(host, GitHubSetupAction(action: action, account: approval?.account, fingerprint: approval?.fingerprint))
            guard fence == generation, actions.available(host) else { return }
            status = value; problem = nil
        } catch {
            guard fence == generation else { return }
            uncertain = true
            problem = "GitHub action is not confirmed. Check this host before trying again. Authorization, registration and revocation are never replayed automatically."
        }
    }
}

@MainActor
struct DevboxGitHubSetup: View {
    let host: HostRef
    @ObservedObject var hosts: HostClients
    @StateObject private var model: GitHubSetupModel
    @State private var approval: GitHubSetupStatus?
    @State private var revoking = false
    @Environment(\.openURL) private var openURL
    init(host: HostRef, hosts: HostClients) {
        self.host = host; self.hosts = hosts
        _model = StateObject(wrappedValue: GitHubSetupModel(host: host, actions: .live(hosts)))
    }
    var body: some View {
        SettingsSection("GitHub", explanation: "Authorize this devbox independently. Its token and private key stay here. Existing SSH configuration and credentials are not replaced.") {
            if !hosts.available.contains(host) {
                SettingsRow { SettingsNote("Disconnected. Reconnect this devbox to check GitHub.") }
            } else {
                SettingsRow(model.status?.account.map { "GitHub · \($0)" } ?? "Connect GitHub",
                            detail: model.status.map { $0.apiReady ? "GitHub CLI/API verified. Repository and SSO permissions still apply." : "GitHub CLI/API access has not been verified." } ?? "Check this devbox before connecting.") {
                    Button("Check access") { Task { await model.perform("verify") } }.controlSize(.small)
                        .disabled(model.busy || model.uncertain || model.status?.working == true)
                }
                if model.status?.apiReady != true {
                    SettingsRow("Browser authorization", detail: "Requires gh, git and OpenSSH on the devbox. No packages are installed.") {
                        Button("Connect GitHub…") { Task { await model.perform("authorize") } }.controlSize(.small)
                            .disabled(model.busy || model.uncertain || model.status?.working == true)
                    }
                }
                if let challenge = model.status?.challenge {
                    SettingsRow("One-time code", detail: challenge.code) {
                        Button("Open GitHub") { if let url = challenge.browserURL { openURL(url) } }.controlSize(.small)
                    }
                }
                if let status = model.status, status.apiReady {
                    SettingsRow("Dedicated SSH key", detail: status.sshReady ? "Identity verified for this GitHub account. Access to each repository is checked separately." : status.fingerprint ?? "Generated only on this devbox. No Mac key or agent forwarding.") {
                        if status.fingerprint == nil {
                            Button("Generate key") { Task { await model.perform("prepare_key") } }.controlSize(.small).disabled(model.busy || model.uncertain)
                        } else if !status.sshReady {
                            Button("Review key…") { revoking = false; approval = status }.controlSize(.small).disabled(model.busy || model.uncertain)
                        }
                        if status.keyId != nil {
                            Button("Revoke key…") { revoking = true; approval = status }.controlSize(.small).disabled(model.busy || model.uncertain)
                        }
                    }
                }
                if model.status?.working == true {
                    SettingsRow("Waiting for GitHub", detail: model.status?.phase == "authorizing" ? "Closing this view does not cancel remote authorization." : "Registration may already have reached GitHub. Refresh to reconcile its result; cancelling cannot undo a sent account change.") {
                        if model.status?.phase == "authorizing" {
                            Button("Cancel authorization") { Task { await model.perform("cancel") } }.controlSize(.small).disabled(model.busy)
                        }
                    }
                }
                SettingsRow {
                    HStack {
                        if model.busy { ProgressView().controlSize(.small) }
                        Button("Refresh state") { Task { await model.refresh() } }.controlSize(.small).disabled(model.busy)
                    }
                }
            }
            if let problem = model.problem ?? model.status?.problem { SettingsRow { InlineProblem(problem) } }
            SettingsRow { SettingsNote("Unknown key registration is reconciled by exact public key, not retried. Organization SSO may need separate approval on GitHub. Revoking this dedicated key does not revoke the CLI token or alter other keys. Existing checkouts are not reconfigured.") }
        }
        .task(id: hosts.available.contains(host)) {
            if hosts.available.contains(host) { await model.refresh() } else { model.detach() }
        }
        .task(id: model.status?.working == true) {
            while model.status?.working == true, !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(3)) } catch { break }
                await model.refresh()
            }
        }
        .onDisappear { model.detach() }
        .sheet(isPresented: Binding(get: { approval != nil }, set: { if !$0 { approval = nil } })) {
            if let value = approval {
                GitHubKeyApprovalSheet(value: value, revoking: revoking, cancel: { approval = nil }) {
                    let action = revoking ? "revoke_key" : "approve_key"
                    approval = nil; Task { await model.perform(action, approval: value) }
                }
            }
        }
    }
}

@MainActor
struct GitHubKeyApprovalSheet: View {
    let value: GitHubSetupStatus
    let revoking: Bool
    let cancel: () -> Void
    let approve: () -> Void
    var body: some View {
        SheetScaffold(revoking ? "Revoke dedicated GitHub key" : "Register dedicated GitHub key",
            subtitle: "Only this devbox and the displayed GitHub account", primary: SheetPrimaryAction(
                title: revoking ? "Revoke key" : "Approve registration", action: approve), cancel: cancel, width: 520) {
            SettingsNote("GitHub account: \(value.account ?? "Unknown")")
            Text(value.fingerprint ?? "").font(.pilot(.body, design: .monospaced)).textSelection(.enabled)
            Text(value.publicKey ?? "").font(.pilot(.caption, design: .monospaced)).textSelection(.enabled)
            SettingsNote(revoking ? "This removes only the exact dedicated key from GitHub. Private key material remains on the devbox. Other keys and login credentials are unchanged." : "Allow this public key to authenticate as you, subject to repository permissions and SSO. The private key never leaves the devbox. Normal SSH host-key checks remain enabled.")
        }
    }
}
