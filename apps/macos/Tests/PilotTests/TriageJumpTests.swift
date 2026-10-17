import Foundation
import PilotCore
import Testing
@testable import Pilot

private let projects = ["p1", "p2", "p3"].map { Project(id: $0, name: "Project \($0)", path: "/tmp/\($0)", createdAt: 1) }

private func source(_ project: String, _ kind: TrackedKind, configured: Bool = true) -> TrackingSource {
    TrackingSource(id: "\(project):\(kind.rawValue)", projectId: project, kind: kind, label: kind.rawValue,
                   configured: configured, status: .ok)
}

@Test func jumpsPreferTheProjectInContextAndNeverGuessAnother() {
    let sources = [source("p1", .slack), source("p3", .slack), source("p2", .linear),
                   source("p2", .slack, configured: false)]
    #expect(TriageJump.projects(.slack, in: projects, sources: sources, preferred: "p3").map(\.id) == ["p3", "p1"])
    #expect(TriageJump.target(.slack, in: projects, sources: sources, preferred: "p3")?.id == "p3")
    #expect(TriageJump.target(.slack, in: projects, sources: sources, preferred: nil) == nil,
            "two candidates and no context: the palette asks")
    #expect(TriageJump.target(.slack, in: projects, sources: sources, preferred: "p2") == nil,
            "a project without Slack is not replaced by another one")
    #expect(TriageJump.target(.linear, in: projects, sources: sources, preferred: nil)?.id == "p2",
            "the only project tracking Linear")
}

@Test @MainActor func linearQueueOpensThePilotListAndSlackTheBoard() {
    let model = AppModel(projectFolderDefaults: UserDefaults(suiteName: "triage-jump-\(UUID())")!)
    model.client.loadFixture(projects: projects, sessions: [])
    model.client.loadTrackingFixture(TrackingFixture(sources: [source("p1", .slack), source("p2", .linear)]))
    model.go(to: .linear)
    #expect(model.selectedProjectId == "p2")
    #expect(model.pendingTrackedSheet == PendingTrackedSheet(projectId: "p2", kind: .linear),
            "the project's own Linear list, not the Linear app")
    #expect(!model.showingCommandPalette)
    model.go(to: .slack)
    #expect(model.currentRoute == .slackTriage("p1"))
}

@Test @MainActor func severalOrNoTrackingProjectsAreChosenInThePalette() throws {
    let model = AppModel(projectFolderDefaults: UserDefaults(suiteName: "triage-pick-\(UUID())")!)
    model.client.loadFixture(projects: projects, sessions: [])
    model.client.loadTrackingFixture(TrackingFixture(sources: [source("p1", .slack), source("p3", .slack)]))
    model.go(to: .slack)
    #expect(model.showingCommandPalette)
    #expect(model.pendingPaletteQuery == "Slack triage")
    model.showingCommandPalette = false
    var settings = 0
    let catalog = CommandPaletteCatalog(model: model, openSettings: { settings += 1 }, openKeyboardShortcuts: {})
    let entries = catalog.entries()
    let slack = entries.filter { $0.item.id.hasPrefix("jump:slack:") }
    #expect(slack.map(\.suffix) == ["Project p1", "Project p3"])
    let linear = try #require(entries.first { $0.item.id == "jump:linear:setup" })
    linear.perform()
    #expect(settings == 1, "Linear is not set up anywhere: Settings, not a dead jump")
    for query in ["linear triage", "linear queue", "slack board"] {
        #expect(!CommandPalette.results(for: query, items: entries.map(\.item)).isEmpty, "\(query)")
    }
}
