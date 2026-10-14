import Testing
@testable import Pilot
@testable import PilotCore

private func brief(_ revision: Int, text: String) -> MissionBrief {
    MissionBrief(missionId: "one", revision: revision, markdown: text, authorSessionId: nil, createdAt: 1)
}

@Test @MainActor func briefDraftSurvivesTabAndPageNavigation() {
    let model = AppModel()
    model.openMission("one", tab: .brief)
    let editor = model.briefEditor(for: "one")
    editor.sync(brief(3, text: "Original"))
    editor.editing = true
    editor.text = "Unsaved changes"
    editor.conflict = 4
    editor.error = "Save failed"

    for tab in MissionTab.allCases {
        model.missionTab = tab
        #expect(model.briefEditor(for: "one") === editor)
    }
    model.openMission("two", tab: .brief)
    let other = model.briefEditor(for: "two")
    #expect(other !== editor)
    other.sync(nil)
    other.editing = true
    other.text = "A different draft"
    model.selectedSessionId = "chat"
    model.openMission("one", tab: .brief)

    let reopened = model.briefEditor(for: "one")
    reopened.sync(brief(4, text: "Concurrent edit"))
    #expect(reopened === editor)
    #expect(reopened.text == "Unsaved changes")
    #expect(reopened.loadedText == "Original" && reopened.baseRevision == 3)
    #expect(reopened.editing && reopened.dirty)
    #expect(reopened.conflict == 4 && reopened.error == "Save failed")
    #expect(other.text == "A different draft")
}

@Test @MainActor func retainedBriefDraftCanDiscardAndFollowLatestRevision() {
    let model = AppModel()
    let editor = model.briefEditor(for: "one")
    editor.sync(brief(1, text: "Original"))
    editor.editing = true
    editor.text = "Draft"
    editor.conflict = 2
    editor.error = "Save failed"
    model.missionTab = .tasks
    let reopened = model.briefEditor(for: "one")
    reopened.discard(latest: brief(2, text: "Latest"))
    #expect(reopened.text == "Latest" && reopened.baseRevision == 2)
    #expect(!reopened.dirty && !reopened.editing)
    #expect(reopened.conflict == nil && reopened.error == nil)
    reopened.sync(brief(3, text: "Updated again"))
    #expect(reopened.text == "Updated again" && reopened.baseRevision == 3)
}
