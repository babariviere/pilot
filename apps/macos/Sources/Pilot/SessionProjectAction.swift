import PilotCore
import SwiftUI

/// Opens the owning project's Overview without changing the sidebar scope.
struct SessionProjectAction: View {
    let session: SessionSummary
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if let projectId = session.projectId, model.client.project(projectId) != nil {
            Button { model.openProject(projectId) } label: {
                Label("Go to project", icon: PilotIcon.project)
            }
        }
    }
}
