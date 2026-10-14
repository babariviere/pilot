import PilotCore
import SwiftUI

struct EnergySettings: View {
    @ObservedObject private var client = AppModel.shared.client
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Group {
            if let status = client.powerStatus {
                EnergySettingsContent(status: status, busy: busy, error: error, update: update)
            } else {
                Section {
                    if let error { Text(error).foregroundStyle(Theme.mutedForeground) }
                    else { ProgressView("Loading energy settings…") }
                    Button("Retry") { Task { await load() } }
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        do { try await client.loadPowerStatus(); error = nil }
        catch { self.error = error.localizedDescription }
    }
    private func update(_ settings: PowerSettings) {
        guard !busy else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do { try await client.updatePowerSettings(settings) }
            catch { self.error = error.localizedDescription }
        }
    }
}

/// Stateless content, shared by native snapshots and the live daemon-backed settings page.
struct EnergySettingsContent: View {
    let status: PowerStatus
    var busy = false
    var error: String?
    var update: (PowerSettings) -> Void = { _ in }

    var body: some View {
        Section {
            Toggle("Keep this Mac awake while agents work", isOn: Binding(
                get: { status.settings.keepAwake },
                set: { update(PowerSettings(keepAwake: $0, closedLid: status.settings.closedLid)) }
            ))
            .disabled(busy || (!status.available && !status.settings.keepAwake))
            Toggle("Keep going with the lid closed", isOn: Binding(
                get: { status.settings.closedLid },
                set: { update(PowerSettings(keepAwake: status.settings.keepAwake, closedLid: $0)) }
            ))
            .disabled(busy || (!status.available && !status.settings.closedLid) || !status.settings.keepAwake)
        } header: {
            Text("While agents work")
        } footer: {
            SettingsFooter("The display can sleep and the screen can lock. Closing Pilot’s window or quitting the app does not stop agents.")
        }
        Section {
            Label("On power and Wi-Fi", systemImage: "powerplug")
                .foregroundStyle(Theme.foreground)
            Text("When closed-lid work is enabled, agents can keep working only with both connected. If either disconnects, Pilot pauses agents and lets this Mac sleep.")
                .font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
            Text("Paused work resumes after the next wake with a connection. Interrupted commands and background jobs are not automatically rerun.")
                .font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
        } header: {
            Text("When the lid closes")
        } footer: {
            SettingsFooter("Closed-lid operation needs a one-time administrator approval for two sleep commands. No Wi-Fi names or Location Services are used. Keep ventilation clear.")
        }
        Section {
            HStack(alignment: .top, spacing: 8) {
                if busy { ProgressView().controlSize(.small) }
                else { Image(systemName: status.paused ? "moon.zzz" : "leaf").foregroundStyle(Theme.mutedForeground) }
                Text(busy ? "Updating energy settings…" : status.summary)
                    .font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let message = error ?? status.error {
                Text(message).font(.pilot(.caption)).foregroundStyle(Theme.destructive)
                    .textSelection(.enabled).accessibilityLabel("Energy settings error: \(message)")
            }
        }
    }
}
