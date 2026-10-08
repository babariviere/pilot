import Foundation
import PilotCore
import Testing

@Test func spawnRequestEncodesOnlyExplicitRemoteBaseBranch() throws {
    let decoder = JSONDecoder()
    let encoder = JSONEncoder()
    let request = SpawnRequest(projectId: "p1", message: "Continue work", baseBranch: "feat/billing")
    let encoded = try encoder.encode(request)
    let json = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    #expect(json["baseBranch"] as? String == "feat/billing")
    #expect(try decoder.decode(SpawnRequest.self, from: encoded).baseBranch == "feat/billing")
    let legacy = Data(#"{"projectId":"p1","message":"Work"}"#.utf8)
    let defaultRequest = try decoder.decode(SpawnRequest.self, from: legacy)
    #expect(defaultRequest.baseBranch == nil)
    let defaultJSON = try #require(JSONSerialization.jsonObject(with: encoder.encode(defaultRequest)) as? [String: Any])
    #expect(defaultJSON["baseBranch"] == nil)
}

@Test func originBranchListDecodesWithAndWithoutDefault() throws {
    let decoder = JSONDecoder()
    let list = try decoder.decode(RemoteBranchList.self, from: Data(#"{"branches":["feat/billing","main"],"defaultBranch":"main"}"#.utf8))
    #expect(list == RemoteBranchList(branches: ["feat/billing", "main"], defaultBranch: "main"))
    let empty = try decoder.decode(RemoteBranchList.self, from: Data(#"{"branches":[]}"#.utf8))
    #expect(empty == RemoteBranchList())
}
