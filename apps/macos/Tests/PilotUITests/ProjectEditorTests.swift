import AppKit
import Foundation
import PilotCore
import SwiftUI
import Testing
@testable import Pilot

private func databaseSettingsFixture(_ revision: String = "baseline") throws -> ProjectDatabaseSettings {
    try JSONDecoder().decode(ProjectDatabaseSettings.self, from: Data("""
    {"revision":"\(revision)","environments":[{"name":"prod","read":{"scheme":"postgres","host":"db.example","port":"5432","database":"app","user":"reader","hasCredentials":true,"access":"ask"}}]}
    """.utf8))
}

@Test @MainActor func databaseEditorKeepsSecretsOnConflictAndClearsThemAfterSave() async throws {
    let editor = ProjectDatabaseEditor()
    await editor.load { try databaseSettingsFixture() }
    #expect(!editor.hasChanges && !editor.busy)
    editor.environments[0].read.replacementURL = "postgres://reader:secret@host/app"
    await editor.save { request in
        #expect(request.revision == "baseline")
        #expect(request.environments[0].read?.url == "postgres://reader:secret@host/app")
        #expect(request.environments[0].read?.access == nil)
        throw ClientError("Reload before saving.", status: 409)
    }
    #expect(editor.error == "Reload before saving.")
    #expect(editor.hasChanges && !editor.busy)
    #expect(editor.environments[0].read.replacementURL.contains("secret"))
    await editor.save { _ in try databaseSettingsFixture("saved") }
    #expect(editor.environments[0].read.replacementURL.isEmpty)
    #expect(editor.snapshot?.revision == "saved")
    #expect(!editor.hasChanges && editor.error == nil)
}

@Test @MainActor func databaseEditorUnreadableSettingsDisableEditingAndSaving() async throws {
    let editor = ProjectDatabaseEditor()
    await editor.load { try databaseSettingsFixture() }
    editor.environments[0].read.access = "allow"
    await editor.save { _ in throw ClientError("Fix the file first.", status: 422) }
    #expect(editor.snapshot == nil && editor.environments.isEmpty && !editor.busy)
    var wrote = false
    await editor.save { _ in wrote = true; return try databaseSettingsFixture() }
    #expect(!wrote)
    await editor.load { throw ClientError("Cannot read settings.", status: 422) }
    #expect(editor.snapshot == nil && editor.error == "Cannot read settings.")
}

@Test @MainActor func databaseEditorIgnoresRetiredLoadsAndDoesNotShareDrafts() async throws {
    let editor = ProjectDatabaseEditor(), other = ProjectDatabaseEditor()
    await editor.load {
        editor.invalidate()
        await editor.load { try databaseSettingsFixture("new host") }
        return try databaseSettingsFixture("retired host")
    }
    #expect(editor.snapshot?.revision == "new host")
    await other.load { try databaseSettingsFixture("other") }
    editor.environments[0].read.replacementURL = "postgres://reader:secret@host/app"
    #expect(other.environments[0].read.replacementURL.isEmpty)
    await editor.save { _ in
        editor.invalidate()
        await editor.load { try databaseSettingsFixture("switched") }
        return try databaseSettingsFixture("old save")
    }
    #expect(editor.snapshot?.revision == "switched")
    #expect(editor.environments[0].read.replacementURL.isEmpty)
    #expect(!editor.busy && !editor.hasChanges)
}

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
        deployed: .init(id: "deployed", name: "Deployed"), canceled: .init(id: "canceled", name: "Won't do"),
        duplicated: .init(id: "duplicate", name: "Duplicate"))]
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
    #expect(editor.request.tracking?.linearStateMappings?["team-child"]?.canceled?.id == "canceled")
    #expect(editor.request.tracking?.linearStateMappings?["team-child"]?.duplicated?.id == "duplicate")
    editor.load(project)
    editor.linearStateMappings["team-child"]?.canceled = nil
    #expect(editor.hasChanges)
    #expect(editor.request.tracking?.linearStateMappings?["team-child"]?.canceled == nil)
    #expect(editor.request.tracking?.linearStateMappings?["team-child"]?.duplicated?.id == "duplicate")
    #expect(editor.request.tracking?.linearStateMappings?["team-child"]?.inProgress?.id == "active")
    editor.load(project)
    editor.linearStateMappings["team-child"]?.duplicated = nil
    #expect(editor.hasChanges)
    #expect(editor.request.tracking?.linearStateMappings?["team-child"]?.duplicated == nil)
    #expect(editor.request.tracking?.linearStateMappings?["team-child"]?.canceled?.id == "canceled")
    editor.linearTeam = nil
    #expect(editor.request.tracking?.linearStateMappings == nil)
    editor.load(Project(id: "q", name: "Other", path: "/other", createdAt: 1))
    #expect(editor.linearStateMappings.isEmpty)
    #expect(!editor.hasChanges)
}

private struct SaveFailure: LocalizedError { var errorDescription: String? { "Save refused" } }

private func settingsProject(_ id: String = "p", name: String = "Repo", model: String? = nil, channels: [String] = ["C1"]) -> Project {
    Project(id: id, name: name, path: "/repo/\(id)", model: model, tracking: .init(slackChannels: channels), createdAt: 1)
}

@Test @MainActor func projectEditorRefreshFollowsServerWhileFormIsClean() {
    let editor = ProjectEditor()
    editor.load(settingsProject())
    editor.refresh(settingsProject(name: "Renamed", model: "gpt", channels: ["C1", "C2"]))
    #expect(editor.name == "Renamed" && editor.model == "gpt")
    #expect(editor.slackChannels.map(\.id) == ["C1", "C2"])
    #expect(!editor.hasChanges && !editor.hasIncomingChanges)
}

@Test @MainActor func projectEditorRefreshKeepsUnsavedEditsAndRevertLoadsLatest() {
    let editor = ProjectEditor()
    editor.load(settingsProject())
    editor.name = "Mine"
    editor.model = "mine-model"
    editor.addChannel(SlackChannelOption(id: "C9", name: "mine"))
    editor.refresh(settingsProject(name: "Theirs", model: "their-model", channels: ["C1", "C2"]))
    #expect(editor.name == "Mine" && editor.model == "mine-model")
    #expect(editor.slackChannels.map(\.id) == ["C1", "C9"])
    #expect(editor.hasChanges && editor.hasIncomingChanges)
    editor.refresh(settingsProject(name: "Theirs again", model: "their-model"))
    #expect(editor.name == "Mine")
    editor.revert()
    #expect(editor.name == "Theirs again" && editor.model == "their-model")
    #expect(editor.slackChannels.map(\.id) == ["C1"])
    #expect(!editor.hasChanges && !editor.hasIncomingChanges)
}

@Test @MainActor func projectEditorRefreshWithUnchangedEditableFieldsRaisesNoNotice() {
    let editor = ProjectEditor()
    editor.load(settingsProject())
    editor.name = "Mine"
    editor.refresh(Project(id: "p", name: "Repo", path: "/moved", tracking: .init(slackChannels: ["C1"]), createdAt: 2))
    #expect(editor.name == "Mine" && editor.hasChanges)
    #expect(!editor.hasIncomingChanges)
}

@Test @MainActor func projectEditorIncomingValueMatchingTheEditsBecomesTheBaseline() {
    let editor = ProjectEditor()
    editor.load(settingsProject())
    editor.name = "Same"
    editor.refresh(settingsProject(name: "Same"))
    #expect(editor.name == "Same")
    #expect(!editor.hasChanges && !editor.hasIncomingChanges)
}

@Test @MainActor func projectEditorSwitchingProjectsLoadsTheOtherProjectAndDropsEdits() {
    let editor = ProjectEditor()
    editor.load(settingsProject("a", name: "A"))
    editor.name = "Edited A"
    editor.refresh(settingsProject("b", name: "B"))
    #expect(editor.name == "B" && !editor.hasChanges && !editor.hasIncomingChanges)
}

@Test @MainActor func projectEditorsForSameIdOnDifferentHostsStayIndependent() {
    let local = ProjectEditor(), remote = ProjectEditor()
    local.load(settingsProject("same", name: "Local"))
    remote.load(settingsProject("same", name: "Remote"))
    local.name = "Local edit"
    remote.refresh(settingsProject("same", name: "Remote updated"))
    #expect(local.name == "Local edit" && local.hasChanges)
    #expect(remote.name == "Remote updated" && !remote.hasChanges)
    local.refresh(settingsProject("same", name: "Local updated"))
    #expect(remote.name == "Remote updated")
    local.revert()
    #expect(local.name == "Local updated")
}

@Test @MainActor func projectEditorSaveFailureKeepsEveryFieldAndErrorUntilRevert() async {
    let editor = ProjectEditor()
    editor.load(settingsProject())
    editor.name = "Mine"
    editor.model = "mine-model"
    await editor.save { _ in throw SaveFailure() }
    #expect(editor.error == "Save refused")
    #expect(editor.name == "Mine" && editor.model == "mine-model" && editor.hasChanges && !editor.isSaving)
    editor.refresh(settingsProject(name: "Theirs"))
    #expect(editor.name == "Mine" && editor.error == "Save refused")
    editor.revert()
    #expect(editor.name == "Theirs" && editor.error == nil)
}

@Test @MainActor func projectEditorSaveAdoptsServerValueWhenNothingChangedDuringIt() async {
    let editor = ProjectEditor()
    editor.load(settingsProject())
    editor.name = " Saved "
    await editor.save { request in
        #expect(request.name == " Saved ")
        return settingsProject(name: "Saved")
    }
    #expect(editor.name == "Saved" && !editor.hasChanges && editor.error == nil)
}

@Test @MainActor func projectEditorTypingDuringSaveStaysUnsavedAndIsNotOverwritten() async {
    let editor = ProjectEditor()
    editor.load(settingsProject())
    editor.name = "First"
    await editor.save { request in
        #expect(request.name == "First")
        editor.name = "First, then more"
        editor.model = "typed-during-save"
        return settingsProject(name: "First")
    }
    #expect(editor.name == "First, then more" && editor.model == "typed-during-save")
    #expect(editor.hasChanges && editor.error == nil)
    // The next save sends what was typed, and the baseline is the first save's result.
    editor.revert()
    #expect(editor.name == "First" && editor.model == "")
}

@Test @MainActor func projectEditorExternalRefreshMatchingTheSaveResponseSettlesCleanly() async {
    let editor = ProjectEditor()
    editor.load(settingsProject())
    editor.name = "Mine"
    await editor.save { _ in
        editor.refresh(settingsProject(name: "Mine"))
        #expect(editor.name == "Mine")
        return settingsProject(name: "Mine")
    }
    #expect(editor.name == "Mine" && !editor.hasChanges && !editor.hasIncomingChanges)
}

@Test @MainActor func projectEditorLateAckOlderThanObservedStateKeepsFormAndRevertLoadsTheObservedState() async {
    let editor = ProjectEditor()
    editor.load(settingsProject())
    editor.name = "Mine"
    await editor.save { _ in
        // Someone else's newer state is observed while this save awaits its receipt, then the older ack arrives.
        editor.refresh(settingsProject(name: "Theirs", model: "theirs"))
        #expect(editor.name == "Mine")
        return settingsProject(name: "Mine")
    }
    #expect(editor.name == "Mine" && editor.error == nil)
    #expect(editor.latest?.name == "Theirs", "The ack must not replace the later observed state")
    #expect(editor.hasChanges && editor.hasIncomingChanges)
    editor.revert()
    #expect(editor.name == "Theirs" && editor.model == "theirs" && !editor.hasChanges && !editor.hasIncomingChanges)
}

@Test @MainActor func projectEditorLateAckNeverOverwritesACleanFormWithAnOlderSnapshot() async {
    let editor = ProjectEditor()
    editor.load(settingsProject())
    editor.name = "Mine"
    await editor.save { _ in
        editor.refresh(settingsProject(name: "Newer"))
        return settingsProject(name: "Older ack")
    }
    #expect(editor.name == "Mine", "Neither the ack nor the observed state may replace what the user submitted")
    #expect(editor.latest?.name == "Newer" && editor.hasIncomingChanges)
    // Saving again sends the form and settles against whatever the server then returns.
    await editor.save { request in
        #expect(request.name == "Mine")
        return settingsProject(name: "Mine")
    }
    #expect(editor.name == "Mine" && !editor.hasChanges && editor.latest?.name == "Mine")
}

@Test @MainActor func projectEditorLateAckAfterTypingStillKeepsObservedStateAndTypedFields() async {
    let editor = ProjectEditor()
    editor.load(settingsProject())
    editor.name = "Mine"
    await editor.save { _ in
        editor.model = "typed"
        editor.refresh(settingsProject(name: "Theirs"))
        return settingsProject(name: "Mine")
    }
    #expect(editor.name == "Mine" && editor.model == "typed" && editor.hasIncomingChanges)
    editor.revert()
    #expect(editor.name == "Theirs" && editor.model == "")
}

@Test @MainActor func projectEditorObservedStateFromBeforeASaveDoesNotAffectItsAck() async {
    let editor = ProjectEditor()
    editor.load(settingsProject())
    editor.name = "Mine"
    editor.refresh(settingsProject(name: "Theirs"))
    await editor.save { _ in settingsProject(name: "Mine") }
    #expect(editor.name == "Mine" && !editor.hasChanges && !editor.hasIncomingChanges && editor.latest?.name == "Mine")
}

@Test @MainActor func projectEditorRejectsSecondSaveAndRevertWhileSaving() async {
    let editor = ProjectEditor()
    editor.load(settingsProject())
    editor.name = "Mine"
    var sends = 0
    await editor.save { _ in
        sends += 1
        editor.revert()
        #expect(editor.name == "Mine")
        await editor.save { _ in sends += 1; return settingsProject() }
        return settingsProject(name: "Mine")
    }
    #expect(sends == 1)
}

@Test @MainActor func projectEditorLateSaveResponseCannotTouchAnotherProject() async {
    let editor = ProjectEditor()
    editor.load(settingsProject("a", name: "A"))
    editor.name = "Edited A"
    await editor.save { _ in
        editor.refresh(settingsProject("b", name: "B"))
        return settingsProject("a", name: "Edited A")
    }
    #expect(editor.name == "B" && !editor.hasChanges && editor.latest?.id == "b")
}

@Test @MainActor func projectEditorBaselineFieldsMatchWhatLoadPutsInTheForm() {
    let labels = [SlackProjectLabel(name: "Client", description: "App", effect: .hide), SlackProjectLabel(name: "", description: "")]
    let project = Project(id: "p", name: "Repo", path: "/repo", model: "m", workspace: "direct", requirePullRequest: false,
                          tracking: .init(slackChannels: ["C1"], linearTeam: "", slackLabels: labels,
                                          slackMentionOnlyChannels: ["C1"], slackGroupHandles: ["a", "b"]), createdAt: 1)
    let editor = ProjectEditor()
    editor.load(project)
    editor.refresh(project)
    editor.name = "x"
    editor.refresh(project)
    #expect(!editor.hasIncomingChanges)
}

@Test(.timeLimit(.minutes(1))) @MainActor
func settingsSaveBarMountsForDirtyFormAndLeavesAfterRevert() async throws {
    _ = NSApplication.shared
    let editor = ProjectEditor()
    editor.load(settingsProject())
    editor.name = "Mine"
    editor.refresh(settingsProject(name: "Theirs"))
    struct Bar: View {
        @ObservedObject var editor: ProjectEditor
        var body: some View {
            if editor.hasChanges {
                SettingsSaveBar(error: editor.error, updatedElsewhere: editor.hasIncomingChanges, saving: editor.isSaving,
                                revert: { editor.revert() }, save: {})
            }
        }
    }
    let hosting = NSHostingView(rootView: Bar(editor: editor).frame(width: 640))
    let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 640, height: 80),
                          styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false; window.contentView = hosting
    window.orderFrontRegardless(); hosting.layoutSubtreeIfNeeded()
    defer { window.close() }
    func settle() async { for _ in 0..<20 { try? await Task.sleep(for: .milliseconds(5)); hosting.layoutSubtreeIfNeeded() } }
    await settle()
    // The mounted bar is present for the dirty form, with the incoming-update notice.
    #expect(hosting.fittingSize.height > 20)
    #expect(editor.hasIncomingChanges && editor.name == "Mine")
    editor.revert()
    await settle()
    #expect(editor.name == "Theirs" && !editor.hasChanges && !editor.hasIncomingChanges)
    #expect(hosting.fittingSize.height < 1)
}
