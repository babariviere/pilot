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
                SettingsSection {
                    SettingsRow {
                        if let error { InlineProblem(error) { Task { await load() } } }
                        else { ProgressView("Loading energy settings…").controlSize(.small) }
                    }
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

/// Stateless content, shared by native snapshots and the live daemon-backed settings page. What happens when the lid
/// closes is told by the closed-lid toggle and the one footer, not a section of its own.
struct EnergySettingsContent: View {
    let status: PowerStatus
    var busy = false
    var error: String?
    var update: (PowerSettings) -> Void = { _ in }

    var body: some View {
        SettingsSection("While agents work", explanation: "The display can sleep and the screen can lock. Closing Pilot’s window or quitting the app does not stop agents. Paused work resumes after the next wake with a connection; interrupted commands and background jobs are not rerun. Closed-lid work needs a one-time administrator approval for two sleep commands, uses no Wi-Fi names or Location Services, and needs clear ventilation.") {
            SettingsToggle("Keep this Mac awake while agents work", isOn: Binding(
                get: { status.settings.keepAwake },
                set: { update(PowerSettings(keepAwake: $0, closedLid: status.settings.closedLid)) }
            ))
            .disabled(busy || (!status.available && !status.settings.keepAwake))
            SettingsToggle("Keep going with the lid closed",
                           detail: "Requires power and Wi-Fi; if either disconnects, Pilot pauses agents and lets this Mac sleep. Pilot does not lock the screen; macOS settings control locking.",
                           isOn: Binding(
                get: { status.settings.closedLid },
                set: { update(PowerSettings(keepAwake: status.settings.keepAwake, closedLid: $0)) }
            ))
            .disabled(busy || (!status.available && !status.settings.closedLid) || !status.settings.keepAwake)
        }
        SettingsSection {
            SettingsRow {
                HStack(alignment: .top, spacing: 8) {
                    if busy { ProgressView().controlSize(.small) }
                    else { PilotSymbol(status.paused ? PilotIcon.idle : PilotIcon.energy).foregroundStyle(Theme.mutedForeground) }
                    Text(busy ? "Updating energy settings…" : status.summary)
                        .font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let message = error ?? status.error {
                SettingsRow { InlineProblem(message) }
            }
        }
    }
}
