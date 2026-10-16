import PilotCore
import SwiftUI

/// Opens the owning project's Overview without changing the sidebar scope.
struct SessionProjectAction: View {
    @Environment(\.hostViewContext) private var hostContext
    @EndpointClient private var endpoint
    let session: SessionSummary
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if let projectId = session.projectId, endpoint.project(projectId) != nil {
            Button { model.openProject(projectId, context: hostContext) } label: {
                Label("Go to project", icon: PilotIcon.project)
            }
        }
    }
}
