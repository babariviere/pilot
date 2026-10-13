import PilotCore
import Testing
@testable import Pilot

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

@Test @MainActor func projectEditorRoundTripsTrackingAndKeepsMcpOverrides() {
    let editor = ProjectEditor()
    let binding = SourceMcpConfig(server: "custom", tools: ["issues": "list"], dispatchTool: "CALL_TOOL")
    editor.load(Project(id: "p", name: "Repo", path: "/repo",
                        tracking: .init(slackChannels: ["C1"], linearTeam: "ENG", mcp: ["linear": binding]), createdAt: 1))
    #expect(editor.slackChannels == "C1")
    editor.slackChannels = " C1, C2 , , bugs "
    editor.linearTeam = " "
    #expect(editor.request.tracking?.slackChannels == ["C1", "C2", "bugs"])
    #expect(editor.request.tracking?.linearTeam == "")
    #expect(editor.request.tracking?.mcp?["linear"] == binding)
    editor.load(Project(id: "q", name: "Other", path: "/other", createdAt: 1))
    #expect(editor.request.tracking?.slackChannels == [])
    #expect(editor.request.tracking?.mcp == nil)
}
