import AppKit
import PilotCore
import SwiftUI

extension Snapshot {
    /// Synthetic delegated work, separate from existing captures so their fixtures stay stable.
    static func renderDelegatedTasks(model: AppModel, to directory: URL) async {
        let json = #"""
        {"mission":{"id":"delegated","projectId":"p1","title":"API v2","goal":"Ship the v2 API and migration guide.","status":"active","briefRevision":1,"createdAt":1,"updatedAt":1},
         "decisions":[],"comments":[],"artifacts":[],"events":[],
         "tasks":[
           {"id":"d1","number":1,"title":"Release checklist","status":"todo","order":1,"milestone":"Release","createdAt":1,"updatedAt":1},
           {"id":"d2","number":2,"title":"Migration guide","status":"blocked","body":"Waiting for the final API examples.","order":2,"milestone":"Release","createdAt":1,"updatedAt":1},
           {"id":"d3","number":3,"title":"Regenerate client SDK","status":"delegated","delegatedTo":"Alex Chen","order":3,"milestone":"Release","sessionId":"sdk","createdAt":1,"updatedAt":1},
           {"id":"d4","number":4,"title":"Cursor pagination","status":"done","order":4,"milestone":"Release","createdAt":1,"updatedAt":1},
           {"id":"d5","number":5,"title":"Publish API reference","status":"done","order":5,"milestone":"Documentation","createdAt":1,"updatedAt":1},
           {"id":"d6","number":6,"title":"Translate migration guide","status":"delegated","order":6,"milestone":"Documentation","createdAt":1,"updatedAt":1},
           {"id":"d7","number":7,"title":"Old docs generator","status":"dropped","order":7,"milestone":"Documentation","createdAt":1,"updatedAt":1},
           {"id":"d8","number":8,"title":"Review SDK compatibility","status":"delegated","delegatedTo":"Sam Rivera, Client Platform and Developer Experience","order":8,"milestone":"Documentation","createdAt":1,"updatedAt":1},
           {"id":"d9","number":9,"title":"Publish client SDK","status":"todo","dependsOn":["d3"],"order":9,"milestone":"Release","createdAt":1,"updatedAt":1}
         ],
         "resources":[
           {"id":"linear-sdk","taskId":"d3","url":"https://linear.app/acme/issue/API-44","kind":"linear.issue","externalId":"API-44","createdAt":1},
           {"id":"linear-review","taskId":"d8","url":"https://linear.app/acme/issue/API-47","kind":"linear.issue","externalId":"API-47","createdAt":1}
         ]}
        """#
        guard let detail = try? JSONDecoder().decode(MissionDetail.self, from: Data(json.utf8)) else {
            fatalError("Invalid delegated task fixture")
        }
        let now = Fixtures.now
        let chat = SessionSummary(id: "sdk", title: "Regenerate client SDK", cwd: "/tmp/demo", projectId: "p1",
                                  createdAt: now, updatedAt: now, state: "working", missionId: detail.mission.id)
        model.client.loadFixture(projects: Fixtures.projects, sessions: [chat])
        model.client.loadMissionFixture([detail])
        for width in [1000, 620] {
            for tab in [MissionTab.tasks, .overview] {
                model.openMission(detail.mission.id, tab: tab)
                await render(MissionPage(missionId: detail.mission.id), size: CGSize(width: CGFloat(width), height: 1000),
                             to: directory.appending(path: "delegated-\(tab.rawValue)-\(width).png"))
            }
        }
    }
}
