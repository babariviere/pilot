import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func projectEditorPreservesMentionFiltersAndGroups() {
    let editor = ProjectEditor()
    editor.load(Project(id: "p", name: "Repo", path: "/repo",
                        tracking: .init(slackChannels: ["C1", "C2"],
                                        slackMentionOnlyChannels: ["C1"], slackGroupHandles: ["oncall"]), createdAt: 1))
    #expect(!editor.hasChanges)
    #expect(editor.slackMentionOnlyChannels == ["C1"])
    #expect(editor.slackGroupHandles == "oncall")
    editor.slackMentionOnlyChannels.insert("C2")
    #expect(editor.hasChanges)
    editor.slackGroupHandles = "@oncall, @client-team"
    #expect(editor.request.tracking?.slackMentionOnlyChannels == ["C1", "C2"])
    #expect(editor.request.tracking?.slackGroupHandles == ["@oncall", "@client-team"])
    editor.removeChannel("C1")
    #expect(editor.request.tracking?.slackMentionOnlyChannels == ["C2"])
    editor.load(Project(id: "q", name: "Other", path: "/other", createdAt: 1))
    #expect(editor.slackMentionOnlyChannels.isEmpty)
    #expect(editor.slackGroupHandles.isEmpty)
    #expect(editor.request.tracking?.slackMentionOnlyChannels == nil)
    #expect(editor.request.tracking?.slackGroupHandles == nil)
}

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

@Test @MainActor func projectEditorTracksAndPreservesPerTeamStateMappings() {
    let states = ["team-child": LinearStateMapping(
        todo: .init(id: "todo", name: "Todo"), inProgress: .init(id: "active", name: "Building"),
        inReview: .init(id: "review", name: "Review"), merged: .init(id: "merged", name: "Merged"),
        deployed: .init(id: "deployed", name: "Deployed"))]
    let editor = ProjectEditor()
    let project = Project(id: "p", name: "Repo", path: "/repo",
                          tracking: .init(linearTeam: "team-root", linearStateMappings: states), createdAt: 1)
    editor.load(project)
    #expect(!editor.hasChanges)
    #expect(editor.linearStateMappings == states)
    editor.name = "Renamed"
    #expect(editor.request.tracking?.linearStateMappings == states)
    editor.load(project)
    editor.linearStateMappings["team-root"] = LinearStateMapping(inProgress: .init(id: "started", name: "In progress"))
    #expect(editor.hasChanges)
    #expect(editor.request.tracking?.linearStateMappings?.count == 2)
    editor.load(project)
    editor.linearStateMappings["team-child"]?.deployed = nil
    #expect(editor.hasChanges)
    #expect(editor.request.tracking?.linearStateMappings?["team-child"]?.deployed == nil)
    #expect(editor.request.tracking?.linearStateMappings?["team-child"]?.merged?.id == "merged")
    editor.linearTeam = nil
    #expect(editor.request.tracking?.linearStateMappings == nil)
    editor.load(Project(id: "q", name: "Other", path: "/other", createdAt: 1))
    #expect(editor.linearStateMappings.isEmpty)
    #expect(!editor.hasChanges)
}
