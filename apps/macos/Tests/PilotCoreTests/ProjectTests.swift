import Foundation
import Testing
@testable import PilotCore

@Test func olderProjectsRequirePullRequestsByDefault() throws {
    let project = try JSONDecoder().decode(Project.self, from: Data(
        #"{"id":"project","name":"Project","path":"/repo","createdAt":1}"#.utf8
    ))
    #expect(project.requirePullRequest == nil)
    #expect(project.effectiveRequirePullRequest)
    #expect(Project(id: "project", name: "Project", path: "/repo", createdAt: 1).effectiveRequirePullRequest)
    #expect(try JSONDecoder().decode(Project.self, from: JSONEncoder().encode(project)) == project)
}

@Test(arguments: [true, false]) func projectPullRequestPolicyRoundTrips(required: Bool) throws {
    let project = try JSONDecoder().decode(Project.self, from: Data(
        """
        {"id":"project","name":"Project","path":"/repo","createdAt":1,"requirePullRequest":\(required)}
        """.utf8
    ))
    #expect(project.requirePullRequest == required)
    #expect(project.effectiveRequirePullRequest == required)
    #expect(try JSONDecoder().decode(Project.self, from: JSONEncoder().encode(project)) == project)
}

@Test func projectRequestOmitsUnchangedPullRequestPolicy() throws {
    let data = try JSONEncoder().encode(ProjectRequest(name: "Renamed"))
    let fields = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(fields["requirePullRequest"] == nil)
    #expect(try JSONDecoder().decode(ProjectRequest.self, from: data).requirePullRequest == nil)
}

@Test(arguments: [true, false]) func projectRequestEncodesExplicitPullRequestPolicy(required: Bool) throws {
    let data = try JSONEncoder().encode(ProjectRequest(requirePullRequest: required))
    let fields = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(fields["requirePullRequest"] as? Bool == required)
    #expect(try JSONDecoder().decode(ProjectRequest.self, from: data).requirePullRequest == required)
}
