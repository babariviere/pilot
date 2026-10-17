import Foundation
import PilotCore
import PilotTelemetry
import SwiftUI

@MainActor
enum NativeTelemetrySettings {
    static func apply(_ settings: TelemetrySettings) {
        guard settings.hostKind == .local, settings.remoteOperational,
              let endpoint = settings.endpoint.flatMap(URL.init(string:)) else {
            try? PilotTelemetry.shared.configure(.disabled)
            return
        }
        let rawVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let version: String
        if let rawVersion, rawVersion.range(of: #"^\d+(?:\.\d+){1,3}$"#, options: .regularExpression) != nil {
            version = rawVersion
        } else {
            version = "0.0.0"
        }
        try? PilotTelemetry.shared.configure(PilotTelemetryConfiguration(
            enabled: true,
            serviceVersion: version,
            environment: Bundle.main.bundleIdentifier == nil ? .development : .release,
            hostKind: .local,
            hostID: settings.hostId,
            endpoint: endpoint
        ))
    }
}

@MainActor
struct TelemetrySettingsSection: View {
    @EndpointClient private var client
    let localApp: Bool
    @State private var loaded: TelemetrySettings?
    @State private var localDiagnostics = true
    @State private var remoteOperational = false
    @State private var productAnalytics = false
    @State private var endpoint = "http://127.0.0.1:4318/v1/traces"
    @State private var saving = false
    @State private var clearing = false
    @State private var confirmClear = false
    @State private var problem: String?
    @State private var saved = false

    init(client: PilotClient? = nil, localApp: Bool) {
        _client = EndpointClient(client)
        self.localApp = localApp
    }

    var body: some View {
        SettingsSection("Collection and export", explanation: "These controls belong only to this host. Local diagnostics never upload. Remote reporting sends only the reviewed content-free schema to your collector.") {
            if loaded == nil {
                if problem == nil {
                    SettingsRow { HStack(spacing: 8) { ProgressView().controlSize(.small); SettingsNote("Loading this host’s settings…") } }
                }
            } else {
                SettingsToggle("Local operational diagnostics", detail: "Keep bounded lifecycle and timing evidence on this host for Diagnose this. On by default.", isOn: $localDiagnostics)
                SettingsToggle("Remote operational reporting", detail: "Send allowlisted traces to the OTLP collector below. Off by default.", isOn: $remoteOperational)
                SettingsToggle("Product analytics", detail: "Allow only cataloged feature events. This remains separate and requires remote reporting to have any effect.", isOn: $productAnalytics)
                SettingsRow("OTLP/HTTP endpoint", detail: "HTTPS, or literal loopback HTTP. Credentials, query parameters and custom headers are not accepted.") {
                    TextField("Collector endpoint", text: $endpoint)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 260)
                        .accessibilityLabel("OTLP collector endpoint")
                }
                SettingsRow {
                    HStack(spacing: 10) {
                        Button(saving ? "Saving…" : "Save") { Task { await save() } }
                            .controlSize(.small).disabled(saving || clearing)
                        Button(clearing ? "Clearing…" : "Clear local diagnostics…") { confirmClear = true }
                            .controlSize(.small).disabled(saving || clearing)
                        if saved { Text("Saved").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground) }
                    }
                }
            }
            if let problem { SettingsRow { InlineProblem(problem) } }
        }
        .task(id: ObjectIdentifier(client)) { await load() }
        .onChange(of: client.connected) { _, connected in if connected { Task { await load() } } }
        .confirmationDialog("Clear local diagnostics on this host?", isPresented: $confirmClear) {
            Button("Clear diagnostics", role: .destructive) { Task { await clear() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes retained lifecycle and timing evidence without deleting chats or changing remote reporting.")
        }
    }

    private func load() async {
        do {
            let settings = try await client.telemetrySettings()
            loaded = settings
            localDiagnostics = settings.localDiagnostics
            remoteOperational = settings.remoteOperational
            productAnalytics = settings.productAnalytics
            endpoint = settings.endpoint ?? "http://127.0.0.1:4318/v1/traces"
            problem = nil
            if localApp { NativeTelemetrySettings.apply(settings) }
        } catch {
            loaded = nil
            problem = client.connected
                ? "Could not read telemetry settings from this host. No upload setting was changed."
                : "This host is disconnected. Its telemetry settings are unavailable, not assumed from Local."
        }
    }

    private func save() async {
        guard !saving else { return }
        saving = true; saved = false
        defer { saving = false }
        do {
            let trimmed = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
            let settings = try await client.updateTelemetrySettings(TelemetrySettingsPatch(
                localDiagnostics: localDiagnostics,
                remoteOperational: remoteOperational,
                productAnalytics: productAnalytics,
                endpoint: trimmed.isEmpty ? nil : trimmed
            ))
            loaded = settings; problem = nil; saved = true
            if localApp { NativeTelemetrySettings.apply(settings) }
        } catch {
            problem = "These settings were not saved. Use HTTPS or loopback HTTP without credentials, a query or fragment."
        }
    }

    private func clear() async {
        guard !clearing else { return }
        clearing = true
        defer { clearing = false }
        do { try await client.clearDiagnostics(); problem = nil }
        catch { problem = "Could not clear this host’s local diagnostic files. No chat was changed or started." }
    }
}

@MainActor
struct TelemetrySettingsPage: View {
    var body: some View {
        SettingsPage("Diagnostics", subtitle: "Private local evidence, optional OpenTelemetry export.") {
            TelemetrySettingsSection(localApp: true)
            SettingsSection("Boundaries", explanation: "Pilot does not export prompts, responses, reasoning, code, paths, tool traffic, integration content, raw errors or credentials. Queues stay in memory and are discarded when reporting is disabled.") {
                SettingsRow { SettingsNote("A collector on 127.0.0.1 is recommended. Configure every devbox independently from its Devboxes page.") }
            }
        }
    }
}
