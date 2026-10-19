import Foundation
import Testing
@testable import PilotCore

@Test func databaseDraftKeepsStoredSecretsAndImplicitAsk() throws {
    let value = try JSONDecoder().decode(ProjectDatabaseSettings.self, from: Data(#"{"revision":"abc","environments":[{"name":"prod","read":{"scheme":"postgres","host":"db.example","port":"5432","database":"app","user":"reader","hasCredentials":true,"access":"ask"}}]}"#.utf8))
    var draft = DatabaseEnvironmentDraft(stored: value.environments[0])
    #expect(draft.read.replacementURL.isEmpty)
    #expect(draft.read.access == "ask")
    #expect(!draft.write.enabled)
    #expect(draft.validationError == nil)
    let update = try #require(draft.update.read)
    #expect(update.url == nil)
    #expect(update.access == nil)
    let fields = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(update)) as? [String: Any])
    #expect(fields.isEmpty)
    draft.read.access = "allow"
    #expect(draft.update.read?.access == "allow")
    draft.read.replacementURL = "postgres://reader:replacement@db/app"
    #expect(draft.update.read?.url == draft.read.replacementURL)
    #expect(draft.read.stored?.summary == "reader@db.example:5432/app")
    #expect(!draft.read.stored!.summary.contains("replacement"))
}

@Test func databaseNewConnectionsDefaultToAskAndWritesAreExplicit() throws {
    var draft = DatabaseEnvironmentDraft()
    #expect(draft.read.enabled)
    #expect(!draft.write.enabled)
    #expect(draft.read.access == "ask")
    #expect(draft.write.access == "ask")
    #expect(draft.validationError != nil)
    draft.name = "local"
    #expect(draft.validationError != nil)
    draft.read.replacementURL = "postgres://ro@localhost/app"
    #expect(draft.validationError == nil)
    #expect(draft.update.write == nil)
    draft.write.enabled = true
    #expect(draft.validationError != nil)
    draft.write.replacementURL = "postgres://rw:secret@localhost/app"
    #expect(draft.validationError == nil)
    #expect(draft.update.write?.access == nil)
    draft.read.enabled = false
    #expect(draft.update.read == nil)
    draft.name = "invalid name"
    #expect(draft.validationError != nil)
}

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
