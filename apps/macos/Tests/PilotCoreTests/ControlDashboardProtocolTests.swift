import Foundation
import PilotCore
import Testing

struct ControlDashboardProtocolTests {
    @Test func snapshotDecodesAllSectionsAndRoundTrips() throws {
        let source = """
        {"untrusted":true,"source":"daemon-memory","projects":[{"id":"p","name":"Project"}],
         "chats":[{"id":"c","chatUrl":"pilot://chat/c","title":"Chat","state":"working","working":true,"model":"test/model","projectId":"p","missionId":"m"}],
         "missions":[{"id":"m","projectId":"p","title":"Mission","status":"active","tasksDone":2,"tasksTotal":3,"coordinatorSessionId":"lead"}],
         "pullRequests":[{"sessionId":"c","url":"https://github.com/example/repo/pull/1","number":1,"title":"PR","state":"open"}],
         "linear":[{"projectId":"p","id":"issue","identifier":"ABC-1","title":"Issue","status":"Started","url":"https://linear.app/example/issue/ABC-1"}],
         "runningAgents":[{"id":"c","chatUrl":"pilot://chat/c","title":"Chat","projectId":"p","missionId":"m","model":"test/model","state":"working","working":true,"startedAt":1000,"elapsedMs":4000}],
         "activeMissions":[{"id":"m","projectId":"p","title":"Mission","status":"active","tasksDone":2,"tasksTotal":3}],
         "blockers":[{"id":"task:t","kind":"blocked_task","projectId":"p","missionId":"m","taskId":"t","taskNumber":3,"title":"Blocked","detail":"Waiting for access","at":300},
         {"id":"chat:failed","kind":"failed_chat","sessionId":"failed","title":"Failed","at":200},
         {"id":"chat:q","kind":"question","sessionId":"q","title":"Question","detail":"Which environment?","at":200},
         {"id":"check:1","kind":"failing_checks","url":"https://github.com/example/repo/pull/1","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","title":"PR","detail":"Tests failed","at":400}],
         "pendingDecisions":[{"id":"proposal","projectId":"p","missionId":"m","decisionId":"d","kind":"edit","text":"New rule","reason":"Requirements changed","authorSessionId":"lead","createdAt":300}],
         "sharedTasks":[{"id":"grant:g","bindingId":"b","projectId":"p","missionId":"m","missionHome":{"hostId":"daemon","daemonId":"mac","lineageId":"mac-lineage"},"source":"mission-home","consistency":"committed","taskId":"t","taskNumber":3,"title":"Remote build","status":"in_progress","delegationId":"g","executionHost":{"hostId":"daemon","daemonId":"devbox","lineageId":"devbox-lineage"},"executionEpoch":7,"grantState":"accepted","running":true},
         {"id":"proposal:pending","bindingId":"remote","projectId":"p","missionId":"rm","missionHome":{"hostId":"daemon","daemonId":"devbox","lineageId":"devbox-lineage"},"source":"replica","consistency":"provisional","proposalId":"pending","proposalState":"pending","title":"Proposed work","replicaSyncedAt":1000,"replicaAgeMs":4000}],
         "replicaMissions":[{"id":"replica:remote:rm","bindingId":"remote","projectId":"p","missionId":"rm","missionHome":{"hostId":"daemon","daemonId":"devbox","lineageId":"devbox-lineage"},"title":"Remote home","status":"active","complete":true,"sequence":10,"consistency":"committed","replicaSyncedAt":1000,"replicaAgeMs":4000}],
         "next":{"watches":[{"id":"w","createdAt":100,"event":"chat.settled","target":{"kind":"chat","id":"c"},"mode":"once","note":"Read the result and report it"}],"total":1,"followThrough":[]},
         "totals":{"projects":1,"chats":1,"missions":1,"pullRequests":1,"linear":1,"runningAgents":1,"activeMissions":1,"blockers":4,"pendingDecisions":1,"sharedTasks":2,"replicaMissions":1},"truncated":false}
        """
        let value = try JSONDecoder().decode(ControlDashboardResponse.self, from: Data(source.utf8))
        #expect(value.untrusted)
        #expect(value.source == "daemon-memory")
        let agent = try #require(value.runningAgents.first)
        #expect(agent.model == "test/model")
        #expect(agent.startedAt == 1000 && agent.elapsedMs == 4000)
        #expect(value.activeMissions.first?.tasksDone == 2)
        #expect(value.blockers.map(\.kind) == [.blockedTask, .failedChat, .question, .failingChecks])
        #expect(value.blockers.last?.headSha == String(repeating: "a", count: 40))
        #expect(value.pendingDecisions.first?.kind == .edit)
        #expect(value.sharedTasks?.first?.executionHost?.daemonId == "devbox")
        #expect(value.sharedTasks?.first?.executionEpoch == 7)
        #expect(value.sharedTasks?.first?.grantState == "accepted")
        #expect(value.sharedTasks?.first?.running == true)
        #expect(value.sharedTasks?.last?.consistency == "provisional")
        #expect(value.sharedTasks?.last?.taskNumber == nil)
        #expect(value.replicaMissions?.first?.replicaAgeMs == 4000)
        #expect(value.totals.sharedTasks == 2 && value.totals.replicaMissions == 1)
        #expect(value.next.watches.first?.note == "Read the result and report it")
        #expect(value.next.total == 1 && value.totals.blockers == 4)
        let roundTrip = try JSONDecoder().decode(ControlDashboardResponse.self, from: JSONEncoder().encode(value))
        #expect(roundTrip == value)
    }

    @Test func emptyAndTruncatedSnapshotsAndInvalidationDecode() throws {
        let source = #"{"untrusted":true,"source":"daemon-memory","projects":[],"chats":[],"missions":[],"pullRequests":[],"linear":[],"runningAgents":[],"activeMissions":[],"blockers":[],"pendingDecisions":[],"next":{"watches":[],"total":200},"totals":{"projects":0,"chats":500,"missions":0,"pullRequests":0,"linear":0,"runningAgents":500,"activeMissions":0,"blockers":0,"pendingDecisions":0},"truncated":true}"#
        let value = try JSONDecoder().decode(ControlDashboardResponse.self, from: Data(source.utf8))
        #expect(value.truncated && value.runningAgents.isEmpty && value.totals.runningAgents == 500)
        #expect(value.next.total == 200)
        #expect(value.sharedTasks == nil && value.replicaMissions == nil)
        guard case .dashboardChanged = try ServerUpdate.decode(Data(#"{"type":"dashboard.changed"}"#.utf8)) else {
            Issue.record("Missing dashboard invalidation"); return
        }
    }
}
