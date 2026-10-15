import PilotCore
import SwiftUI

/// Where automatic input came from, as named in the composer tray's system messages.
extension InputOrigin {
    var title: String {
        switch self {
        case .job: "Background job"
        case .subagent: "Subagent"
        case .extension: "Automatic message"
        case .coordinator: "Coordinator"
        case .mission: "Mission"
        case .pullRequest: "PR follow-up"
        }
    }

    var icon: PilotIcon {
        switch self {
        case .job: PilotIcon.terminal
        case .subagent: PilotIcon.subagents
        case .extension: PilotIcon.extensionTool
        case .coordinator: PilotIcon.coordinator
        case .mission: PilotIcon.mission
        case .pullRequest: PilotIcon.pullRequest
        }
    }
}
