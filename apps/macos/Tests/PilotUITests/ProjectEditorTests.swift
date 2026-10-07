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
