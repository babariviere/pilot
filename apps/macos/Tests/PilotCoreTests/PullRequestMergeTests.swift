import Foundation
import Testing
@testable import PilotCore

@Test func mergeConfirmationRoundTripsWithTheConfirmedHeadAndMethod() throws {
    let json = #"{"url":"https://github.com/o/r/pull/42","number":42,"title":"Fix export","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","headBranch":"fix/export","baseBranch":"main","methods":["squash","merge"]}"#
    let preview = try JSONDecoder().decode(PullRequestMergePreview.self, from: Data(json.utf8))
    #expect(preview.methods.map(\.label) == ["Squash and merge", "Create a merge commit"])
    let request = MergePullRequestRequest(preview: preview, method: .merge)
    let encoded = try JSONEncoder().encode(request)
    let body = try JSONDecoder().decode([String: String].self, from: encoded)
    #expect(body == ["url": preview.url, "headSha": preview.headSha, "baseBranch": "main", "method": "merge"])
    #expect(try JSONDecoder().decode(MergePullRequestRequest.self, from: encoded) == request)
}
