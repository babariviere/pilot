import Foundation
import PilotCore
import PilotTelemetry
import SwiftUI

@MainActor
enum NativeTelemetrySettings {
    static func apply(_ settings: TelemetrySettings) {
        NativeDiagnostics.shared.setEnabled(settings.localDiagnostics)
        NativeAppLog.shared.setEnabled(settings.hostKind == .local && settings.localDiagnostics)
        LocalFeatureUsage.shared.configure(enabled: settings.hostKind == .local && settings.localFeatureUsage == true,
                                           epoch: settings.featureUsageEpoch)
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
            analyticsID: settings.productAnalytics ? settings.analyticsId : nil,
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
    @State private var localFeatureUsage = false
    @State private var remoteOperational = false
    @State private var productAnalytics = false
    @State private var endpoint = "http://127.0.0.1:4318/v1/traces"
    @State private var budgetBasis: AIUsageBudgetBasis = .catalogEstimate
    @State private var budgetUSD = ""
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
                SettingsToggle("Local operational diagnostics", detail: "Keep bounded lifecycle, timing and native crash/hang evidence on this host for Diagnose this. On by default.", isOn: $localDiagnostics)
                SettingsToggle("Local feature usage", detail: "Keep content-free daily UI counts across chats for seven UTC days on this host. Off by default, independent of uploads. Disabling or clearing deletes the aggregates. Missing observations are unknown, not zero.", isOn: $localFeatureUsage)
                    .disabled(loaded?.localFeatureUsage == nil)
                SettingsToggle("Remote operational reporting", detail: "Send allowlisted traces to the OTLP collector below. Off by default.", isOn: $remoteOperational)
                SettingsToggle("Product analytics", detail: "Allow only cataloged feature events. This remains separate and requires remote reporting to have any effect.", isOn: $productAnalytics)
                SettingsRow("OTLP/HTTP endpoint", detail: "HTTPS, or literal loopback HTTP. Credentials, query parameters and custom headers are not accepted.") {
                    TextField("Collector endpoint", text: $endpoint)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 260)
                        .accessibilityLabel("OTLP collector endpoint")
                }
                SettingsRow("Informational AI cost budget", detail: "Optional comparison against this chat’s retained usage. Empty means unset. Diagnostics only; it never pauses work or changes providers.") {
                    HStack(spacing: 8) {
                        Picker("Cost basis", selection: $budgetBasis) {
                            Text("Catalog estimate").tag(AIUsageBudgetBasis.catalogEstimate)
                            Text("Billed spend").tag(AIUsageBudgetBasis.billed)
                        }
                        .labelsHidden()
                        .frame(width: 142)
                        TextField("Not set", text: $budgetUSD)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 92)
                            .accessibilityLabel("AI cost budget in US dollars")
                        Text("USD").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    }
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
            Text("This removes retained lifecycle, timing, native crash/hang evidence and local feature-usage aggregates without deleting chats or changing remote reporting.")
        }
    }

    private func load() async {
        do {
            let settings = try await client.telemetrySettings()
            loaded = settings
            localDiagnostics = settings.localDiagnostics
            localFeatureUsage = settings.localFeatureUsage == true
            remoteOperational = settings.remoteOperational
            productAnalytics = settings.productAnalytics
            endpoint = settings.endpoint ?? "http://127.0.0.1:4318/v1/traces"
            budgetBasis = settings.aiUsageBudget?.basis ?? .catalogEstimate
            budgetUSD = settings.aiUsageBudget.map { formattedBudget($0.limitUsdMicros) } ?? ""
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
            let trimmedBudget = budgetUSD.trimmingCharacters(in: .whitespacesAndNewlines)
            let aiUsageBudget: AIUsageBudget?
            if trimmedBudget.isEmpty {
                aiUsageBudget = nil
            } else {
                guard trimmedBudget.count <= 24,
                      trimmedBudget.range(
                        of: #"^(?:0|[1-9][0-9]*)(?:[.][0-9]{1,6})?$"#,
                        options: .regularExpression
                      ) != nil,
                      let dollars = Decimal(string: trimmedBudget, locale: Locale(identifier: "en_US_POSIX"))
                else {
                    problem = "Enter a positive USD amount with at most six decimal places, or leave the budget empty."
                    return
                }
                let micros = NSDecimalNumber(decimal: dollars * 1_000_000).doubleValue
                guard micros.isFinite, micros >= 1, micros <= 9_007_199_254_740_991,
                      micros.rounded() == micros else {
                    problem = "Enter a positive USD amount with at most six decimal places, or leave the budget empty."
                    return
                }
                aiUsageBudget = AIUsageBudget(basis: budgetBasis, limitUsdMicros: micros)
            }
            let settings = try await client.updateTelemetrySettings(TelemetrySettingsPatch(
                localDiagnostics: localDiagnostics,
                remoteOperational: remoteOperational,
                productAnalytics: productAnalytics,
                endpoint: trimmed.isEmpty ? nil : trimmed,
                aiUsageBudget: aiUsageBudget,
                localFeatureUsage: loaded?.localFeatureUsage == nil ? nil : localFeatureUsage
            ))
            loaded = settings; problem = nil; saved = true
            if localApp { NativeTelemetrySettings.apply(settings) }
        } catch {
            problem = "These settings could not be fully applied. Check this host's connection and local storage. Use HTTPS or loopback HTTP without credentials, a query or fragment."
        }
    }

    private func clear() async {
        guard !clearing else { return }
        clearing = true
        defer { clearing = false }
        let nativeWasEnabled = NativeDiagnostics.shared.isEnabled
        let appLogWasEnabled = NativeAppLog.shared.isEnabled
        if localApp { NativeAppLog.shared.setEnabled(false) }
        defer { if localApp { NativeAppLog.shared.setEnabled(appLogWasEnabled) } }
        if localApp { NativeDiagnostics.shared.setEnabled(false) }
        defer { if localApp { NativeDiagnostics.shared.setEnabled(nativeWasEnabled) } }
        do {
            try await client.clearDiagnostics()
            if localApp { try await NativeDiagnostics.shared.clear(); try await NativeAppLog.shared.clear() }
            await load()
            problem = nil
        }
        catch { problem = "Could not clear this host’s local diagnostic files. No chat was changed or started." }
    }

    private func formattedBudget(_ micros: Double) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.numberStyle = .decimal
        formatter.usesGroupingSeparator = false
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = 6
        return formatter.string(from: NSNumber(value: micros / 1_000_000)) ?? ""
    }
}

@MainActor
struct TelemetrySettingsPage: View {
    var body: some View {
        SettingsPage("Diagnostics", subtitle: "Private local evidence, optional OpenTelemetry export.") {
            TelemetrySettingsSection(localApp: true)
            DiagnosticRepairProjectSettings()
            SettingsSection("Boundaries", explanation: "Pilot does not export prompts, responses, reasoning, code, paths, tool traffic, integration content, raw errors or credentials. Queues stay in memory and are discarded when reporting is disabled.") {
                SettingsRow { SettingsNote("A collector on 127.0.0.1 is recommended. Configure every devbox independently from its Devboxes page.") }
            }
        }
    }
}
