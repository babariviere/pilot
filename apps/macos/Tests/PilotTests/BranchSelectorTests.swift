import PilotCore
import Testing
@testable import Pilot

private let branchFixture = RemoteBranchList(branches: ["feat/billing", "main"], defaultBranch: "main")

@Test @MainActor func branchSelectionIsScopedToPrivateProjectAndAdvertisedBranches() async {
    let state = BranchSelectorState()
    await state.load(scope: "a") { branchFixture }
    #expect(state.selection(for: "a") == nil)
    state.select("local-only", for: "a")
    #expect(state.selected == nil)
    state.select("feat/billing", for: "wrong-project")
    #expect(state.selected == nil)
    state.select("feat/billing", for: "a")
    #expect(state.selection(for: "a") == "feat/billing")
    #expect(state.selection(for: "b") == nil)
    #expect(state.selection(for: nil) == nil)
    await state.load(scope: "b") { branchFixture }
    #expect(state.selected == nil)
    state.select("main", for: "b")
    state.select(nil, for: "b")
    #expect(state.selected == nil)
    await state.load(scope: nil) { Issue.record("Direct workspaces must not request branches"); return branchFixture }
    #expect(state.list.branches.isEmpty)
    #expect(!state.loading)
}

@Test @MainActor func branchRefreshKeepsSelectionUnlessRemoteBranchWasRemoved() async {
    let state = BranchSelectorState()
    await state.load(scope: "a") { branchFixture }
    state.select("feat/billing", for: "a")
    await state.load(scope: "a") { branchFixture }
    #expect(state.selected == "feat/billing")
    await state.load(scope: "a") { RemoteBranchList(branches: ["main"], defaultBranch: "main") }
    #expect(state.selected == nil)
    #expect(state.error?.contains("no longer on origin") == true)
}

@Test @MainActor func lateBranchResponseCannotOverwriteAnotherProject() async {
    let state = BranchSelectorState()
    await state.load(scope: "a") {
        #expect(state.loading)
        await state.load(scope: "b") { RemoteBranchList(branches: ["release"], defaultBranch: "release") }
        state.select("release", for: "b")
        return branchFixture
    }
    #expect(state.scope == "b")
    #expect(state.list.branches == ["release"])
    #expect(state.selection(for: "b") == "release")
    #expect(!state.loading)
}

@Test @MainActor func failedBranchRefreshCanBeRetriedAndDoesNotLeakIntoNextProject() async {
    let state = BranchSelectorState()
    await state.load(scope: "a") { throw ClientError("Origin is unavailable") }
    #expect(state.error == "Origin is unavailable")
    #expect(!state.loading)
    await state.load(scope: "a") { branchFixture }
    #expect(state.error == nil)
    state.select("feat/billing", for: "a")
    await state.load(scope: "b") { throw ClientError("Origin is unavailable") }
    #expect(state.selected == nil)
    #expect(state.list.branches.isEmpty)
}

@Test @MainActor func latestBranchRefreshWinsEvenOnTheSameProject() async {
    let state = BranchSelectorState()
    await state.load(scope: "a") {
        await state.load(scope: "a") { RemoteBranchList(branches: ["new"], defaultBranch: "new") }
        return branchFixture
    }
    #expect(state.list.branches == ["new"])
    #expect(!state.loading)
}
