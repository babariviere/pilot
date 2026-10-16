import Combine
import PilotCore
import SwiftUI

@MainActor
struct DevboxProviderAttachment {
    var answer: (String, String) async throws -> Void
    var close: () -> Void
}

@MainActor
struct DevboxProviderActions {
    var available: (HostRef) -> Bool
    var readiness: (HostRef) async throws -> SetupReadiness
    var runs: (HostRef) async throws -> [HostedSetupRun]
    var start: (HostRef, SetupStartRequest) async throws -> HostedSetupRun
    var cancel: (HostedSetupRun) async throws -> HostedSetupRun
    var logout: (String, HostRef) async throws -> SetupCredentialStatus
    var attach: (HostedSetupRun, @escaping (SetupServerMessage) -> Void) throws -> DevboxProviderAttachment

    static func live(_ hosts: HostClients) -> Self {
        Self(available: { hosts.available.contains($0) }, readiness: { try await hosts.setupReadiness(on: $0) },
             runs: { try await hosts.setupRuns(on: $0) }, start: { try await hosts.startSetup(on: $0, request: $1) },
             cancel: { try await hosts.cancelSetup($0) }, logout: { try await hosts.logoutSetupProvider($0, on: $1) },
             attach: { value, receive in
                 let connection = try hosts.attachSetup(value, receive: receive)
                 return DevboxProviderAttachment(answer: { try await connection.answer(challengeId: $0, answer: $1) },
                     close: { hosts.detachSetup(value) })
             })
    }
}

@MainActor
final class DevboxProviderModel: ObservableObject {
    let host: HostRef
    @Published private(set) var readiness: SetupReadiness?
    @Published private(set) var runs: [HostedSetupRun] = []
    @Published private(set) var selected: HostedSetupRun?
    /// Ephemeral only. Never add this object or an answer to defaults, outboxes, history or logs.
    @Published private(set) var challenge: SetupChallenge?
    @Published private(set) var problem: String?
    @Published private(set) var notice: String?
    @Published private(set) var busy = false
    @Published private(set) var uncertainStart = false
    private let actions: DevboxProviderActions
    private var attachment: DevboxProviderAttachment?
    private var generation = UUID()
    private var refreshAfterOperation = false

    init(host: HostRef, actions: DevboxProviderActions) { self.host = host; self.actions = actions }
    var available: Bool { actions.available(host) }

    func refresh() async {
        guard !busy, available else { return }
        busy = true; defer { finishOperation() }
        let generation = self.generation
        do {
            async let nextReadiness = actions.readiness(host)
            async let nextRuns = actions.runs(host)
            let (readiness, runs) = try await (nextReadiness, nextRuns)
            guard self.generation == generation, available, runs.allSatisfy({ $0.host == host }) else { return }
            self.readiness = readiness; self.runs = runs; problem = nil; uncertainStart = false
        } catch { if self.generation == generation { problem = "Could not check this devbox's sign-ins. Reconnect or check again. Existing state has been kept." } }
    }

    func start(_ provider: SetupProvider) async {
        guard !busy, available, !uncertainStart, let method = provider.methods.first else { return }
        busy = true; problem = nil; defer { finishOperation() }
        let generation = self.generation
        do {
            let run = try await actions.start(host, SetupStartRequest(provider: provider.id, method: method))
            guard self.generation == generation, available, run.host == host else { return }
            try attach(run)
        } catch {
            guard self.generation == generation else { return }
            uncertainStart = true
            problem = "Sign-in may have started on this devbox. Check existing sign-ins before starting another. Nothing will be retried automatically."
        }
    }

    func resume(_ run: HostedSetupRun) {
        guard !busy, available, run.host == host else { return }
        do { try attach(run); problem = nil }
        catch { problem = "Could not reattach to this sign-in. Check this devbox's existing sign-ins." }
    }

    private func attach(_ value: HostedSetupRun) throws {
        detach()
        selected = value
        let generation = self.generation
        attachment = try actions.attach(value) { [weak self] message in
            guard let self, self.generation == generation, self.available else { return }
            switch message {
            case let .state(run):
                guard run.id == value.run.id else { return }
                self.selected = HostedSetupRun(host: self.host, run: run)
                if run.state != .waiting { self.challenge = nil }
                if [.done, .failed, .cancelled].contains(run.state) {
                    if run.reauthenticationRequired { self.problem = "This sign-in needs fresh authentication. Check readiness before starting again." }
                    self.attachment?.close(); self.attachment = nil
                    if run.state == .done { self.requestReadinessRefresh() }
                }
            case let .challenge(challenge): self.challenge = challenge
            case .error:
                self.challenge = nil
                self.problem = "The private sign-in connection was interrupted. Reattach explicitly; answers are never replayed."
            case .output: break // The helper's raw output is never an authoring surface or transcript.
            }
        }
    }

    /// Called only with a whole answer supplied by the view. It is not retained as model state.
    func answer(_ value: String) async {
        guard !busy, available, value.utf8.count <= 4096, let challenge, let attachment else { return }
        busy = true; self.challenge = nil; defer { finishOperation() }
        let generation = self.generation
        do { try await attachment.answer(challenge.id, value) }
        catch { if self.generation == generation { problem = "The answer was not confirmed. Check this sign-in before trying again; it will not be replayed." } }
    }

    func cancel() async {
        guard !busy, available, let selected else { return }
        busy = true; challenge = nil; defer { finishOperation() }
        let generation = self.generation
        do {
            let result = try await actions.cancel(selected)
            guard self.generation == generation, result.host == host else { return }
            self.selected = result
            detach()
            problem = result.run.reauthenticationRequired ? "The cancelled sign-in requires fresh authentication. Check readiness before signing in again." : nil
        } catch { if self.generation == generation { problem = "Cancellation is not confirmed. Check this sign-in after reconnecting. No cancellation will be replayed automatically." } }
    }

    func logout(_ provider: String) async {
        guard !busy, available else { return }
        busy = true; defer { finishOperation() }
        do { _ = try await actions.logout(provider, host); problem = nil; notice = "Stored authentication was removed from this devbox. Environment and provider-side grants are unchanged."; refreshAfterOperation = true }
        catch { problem = "Removing stored authentication was not confirmed. Recheck this devbox before signing in again." }
    }

    func detach() {
        generation = UUID(); challenge = nil; refreshAfterOperation = false
        attachment?.close(); attachment = nil
    }

    private func finishOperation() {
        busy = false
        if refreshAfterOperation { refreshAfterOperation = false; requestReadinessRefresh() }
    }

    private func requestReadinessRefresh() {
        if busy { refreshAfterOperation = true; return }
        Task { [weak self] in await self?.refresh() }
    }
}

@MainActor
struct DevboxProviderSetup: View {
    let host: HostRef
    @ObservedObject var hosts: HostClients
    @StateObject private var model: DevboxProviderModel
    @State private var response = ""
    @State private var logoutProvider: SetupProvider?
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    init(host: HostRef, hosts: HostClients) {
        self.host = host; self.hosts = hosts
        _model = StateObject(wrappedValue: DevboxProviderModel(host: host, actions: .live(hosts)))
    }

    var body: some View {
        SettingsSection("Providers", explanation: "Sign in independently on this devbox. A working chat is not required. Stored authentication is not a live provider health check, and nothing is copied from your Mac.") {
            if !hosts.available.contains(host) {
                SettingsRow { SettingsNote("Disconnected. Reconnect this devbox to check or change sign-ins.") }
            } else if let readiness = model.readiness {
                ForEach(readiness.providers.filter { !$0.methods.isEmpty }) { provider in
                    SettingsRow(provider.name, detail: DevboxProviderCopy.credential(provider.credential)) {
                        Button(provider.credential == .configured ? "Sign in again" : "Sign in") { Task { await model.start(provider) } }
                            .controlSize(.small).disabled(model.busy || model.uncertainStart)
                            .contextMenu { Button("Remove stored sign-in…") { logoutProvider = provider } }
                    }
                }
                if let run = model.selected {
                    SettingsRow(DevboxProviderCopy.run(run.run), detail: "This is a private setup helper, not a chat terminal.") {
                        if [.starting, .waiting, .working].contains(run.run.state) {
                            if model.challenge == nil {
                                Button("Reattach") { model.resume(run) }.controlSize(.small).disabled(model.busy)
                            }
                            Button("Cancel sign-in") { response = ""; Task { await model.cancel() } }.controlSize(.small).disabled(model.busy)
                        }
                    }
                }
                if let challenge = model.challenge { challengeContent(challenge) }
                let waiting = model.runs.filter { [.starting, .waiting, .working].contains($0.run.state) && $0.run.id != model.selected?.run.id }
                ForEach(waiting.prefix(4), id: \.run.id) { value in
                    SettingsRow("Existing sign-in", detail: value.run.provider) {
                        Button("Reattach") { model.resume(value) }.controlSize(.small).disabled(model.busy)
                    }
                }
                SettingsRow {
                    DisclosureGroup("Other providers") {
                        SettingsNote("Other provider flows are not supported by this setup helper. Configure them independently on the devbox with pi. Browser callbacks are not forwarded between machines.")
                    }.font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
                }
            } else {
                SettingsRow { SettingsNote(model.busy ? "Checking stored authentication…" : "Check this devbox's stored authentication before signing in.") }
            }
            SettingsRow {
                HStack {
                    if model.busy { ProgressView().controlSize(.small) }
                    Button("Check sign-ins") { Task { await model.refresh() } }.controlSize(.small).disabled(model.busy || !hosts.available.contains(host))
                }
            }
            if let problem = model.problem { SettingsRow { InlineProblem(problem) } }
            if let notice = model.notice { SettingsRow { SettingsNote(notice) } }
        }
        if let integrations = model.readiness?.integrations {
            SettingsSection("Linear and Slack", explanation: "These connections belong to this devbox's global pi configuration. Local Connections settings remain unchanged.") {
                ForEach(integrations, id: \.kind) { integration in
                    SettingsRow {
                        SettingsRowLabel(title: integration.kind == "linear" ? "Linear" : "Slack",
                            detail: DevboxProviderCopy.integration(integration))
                    }
                }
            }
        }
        EmptyView()
            .task(id: hosts.available.contains(host)) {
                if hosts.available.contains(host) { await model.refresh() } else { response = ""; model.detach() }
            }
            .onChange(of: model.challenge?.id) { _, _ in response = "" }
            .onChange(of: scenePhase) { _, phase in if phase != .active { response = "" } }
            .onDisappear { response = ""; model.detach() }
            .confirmationDialog("Remove stored sign-in from this devbox?", isPresented: Binding(get: { logoutProvider != nil }, set: { if !$0 { logoutProvider = nil } })) {
                if let provider = logoutProvider {
                    Button("Remove stored sign-in", role: .destructive) { logoutProvider = nil; response = ""; Task { await model.logout(provider.id) } }
                }
            } message: { Text("This does not change your Mac, environment variables or the provider's account permissions.") }
    }

    @ViewBuilder private func challengeContent(_ challenge: SetupChallenge) -> some View {
        SettingsRow {
            VStack(alignment: .leading, spacing: 8) {
                if let code = challenge.userCode {
                    Text("Enter this one-time code on the sign-in page:").font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
                    Text(code).font(.pilot(.body, weight: .semibold, design: .monospaced)).foregroundStyle(Theme.foreground)
                }
                Button("Open sign-in page") {
                    guard let url = URL(string: challenge.url), url.scheme == "https" else { return }
                    openURL(url)
                }.controlSize(.small)
                if challenge.type == .manualCode {
                    SecureField("Paste the complete code#state", text: $response).textFieldStyle(.roundedBorder)
                        .onChange(of: response) { _, value in if value.utf8.count > 4096 { response = "" } }
                        .accessibilityLabel("Private authorization response")
                    Button("Complete sign-in") {
                        let answer = response; response = ""
                        Task { await model.answer(answer) }
                    }.controlSize(.small).disabled(response.isEmpty || model.busy)
                }
                SettingsNote("This challenge is temporary. Do not put it in a chat, history or a shared note.")
            }
        }
    }
}

enum DevboxProviderCopy {
    static func credential(_ value: SetupCredentialState) -> String {
        switch value {
        case .missing: "No stored sign-in"
        case .configured: "Stored sign-in present. Provider access is not yet verified."
        case .reauthenticationRequired: "A fresh sign-in is required."
        }
    }
    static func run(_ value: SetupRun) -> String {
        switch value.state {
        case .starting: "Starting sign-in…"
        case .waiting: "Waiting for authorization"
        case .working: "Completing sign-in…"
        case .done: "Sign-in saved on this devbox"
        case .failed: "Sign-in did not complete"
        case .cancelled: "Sign-in cancelled"
        }
    }
    static func integration(_ value: SetupIntegration) -> String {
        if value.state == "connected" { return "Connected on this devbox" }
        if value.state == "disabled" { return "Turned off in this devbox's pi configuration" }
        return "Configure and sign in independently with pi on this devbox. A remote browser callback is not supported by this helper."
    }
}
