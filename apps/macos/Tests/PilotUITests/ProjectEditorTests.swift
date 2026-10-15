import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func projectEditorPreservesSlackLabelsWithoutAnEditor() {
    let labels = [SlackProjectLabel(name: "Client", description: "App support", effect: .hide)]
    let editor = ProjectEditor()
    editor.load(Project(id: "p", name: "Example", path: "/example", tracking: .init(slackChannels: ["C1"], slackLabels: labels), createdAt: 0))
    editor.name = "Renamed example"
    #expect(editor.request.tracking?.slackLabels == labels)
    editor.load(Project(id: "q", name: "Other", path: "/other", createdAt: 0))
    #expect(editor.request.tracking?.slackLabels == nil)
}

@Test @MainActor func projectEditorLoadsDefaultPolicyAndSavesDisabledPolicy() {
    let editor = ProjectEditor()
    #expect(editor.requirePullRequest)
    editor.load(Project(id: "project", name: "Project", path: "/repo", createdAt: 1))
    #expect(editor.requirePullRequest)
    #expect(editor.request.requirePullRequest == true)

    editor.requirePullRequest = false
    #expect(editor.request.requirePullRequest == false)
    #expect(editor.request.name == "Project")
    #expect(editor.request.model == "")
    #expect(editor.request.workspace == "clone")
}

@Test @MainActor func projectEditorReloadsExplicitPolicyWithoutLeakingBetweenProjects() {
    let editor = ProjectEditor()
    editor.load(Project(
        id: "direct", name: "Direct", path: "/repo", workspace: "direct",
        requirePullRequest: false, createdAt: 1
    ))
    #expect(!editor.requirePullRequest)
    #expect(editor.request.requirePullRequest == false)
    #expect(editor.request.workspace == "direct")

    editor.load(Project(id: "legacy", name: "Legacy", path: "/other", createdAt: 1))
    #expect(editor.requirePullRequest)
    #expect(editor.request.requirePullRequest == true)
    #expect(editor.request.workspace == "clone")
}

@Test @MainActor func projectEditorRoundTripsTracking() {
    let editor = ProjectEditor()
    editor.load(Project(id: "p", name: "Repo", path: "/repo",
                        tracking: .init(slackChannels: ["C1", "bugs"], slackChannelNames: ["C1": "general"],
                                        linearTeam: "team-1", linearTeamName: "Platform"), createdAt: 1))
    #expect(editor.slackChannels.map(\.display) == ["#general", "#bugs"])
    #expect(editor.linearTeam == TrackedTeamRef(id: "team-1", name: "Platform"))
    editor.addChannel(SlackChannelOption(id: "C2", name: "app-bugs", isPrivate: true))
    editor.addChannel(SlackChannelOption(id: "C1", name: "renamed"))
    editor.removeChannel("bugs")
    #expect(editor.request.tracking?.slackChannels == ["C1", "C2"])
    #expect(editor.request.tracking?.slackChannelNames == ["C1": "general", "C2": "app-bugs"])
    #expect(editor.request.tracking?.linearTeam == "team-1")
    #expect(editor.request.tracking?.linearTeamName == "Platform")
    editor.linearTeam = nil
    #expect(editor.request.tracking?.linearTeam == "")
    #expect(editor.request.tracking?.linearTeamName == nil)
    editor.load(Project(id: "q", name: "Other", path: "/other", createdAt: 1))
    #expect(editor.request.tracking?.slackChannels == [])
    #expect(editor.request.tracking?.slackChannelNames == nil)
}
