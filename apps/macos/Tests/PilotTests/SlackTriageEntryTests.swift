import Foundation
import PilotCore
import Testing
@testable import Pilot

private let local = HostRef(hostId: "local", daemonId: "triage-local", lineageId: "1")
private let remote = HostRef(hostId: "devbox", daemonId: "triage-remote", lineageId: "2")
private let project = Project(id: "same", name: "Repository", path: "/repo",
                              tracking: .init(slackChannels: ["C1"]), createdAt: 1)

@MainActor private func fixture() throws -> AppModel {
    let app = AppModel(projectFolderDefaults: UserDefaults(suiteName: "triage-entry-\(UUID())")!)
    app.client.loadFixture(projects: [project], sessions: [])
    app.client.loadTrackingFixture(TrackingFixture(sources: [
        TrackingSource(id: "slack", projectId: project.id, kind: .slack, label: "Slack",
                       configured: true, status: .ok),
    ]))
    app.client.fixtureInbox = Inbox(slack: InboxSlackSection(total: 0, items: []))
    try app.registerLocal(local)
    try app.hosts.install(app.client, host: local)
    return app
}

@Test @MainActor func slackTriageEntryNormalizesLocalAndRemoteProjectKeys() throws {
    let app = try fixture()
    for host in [local, remote] {
        let context = HostViewContext(host: host, hosts: app.hosts)
        let ref = context.ref(.project, project.id)
        for qualified in [false, true] {
            app.openSlackTriage(qualified ? ref.storageKey : project.id, caseId: "case", context: context)
            let key = host == local ? project.id : ref.storageKey
            #expect(app.selectedProjectId == key)
            #expect(app.slackTriageProjectId == key, "the window must select triage, not the Overview")
            #expect(app.slackTriageCaseId == "case")
            app.openProject(project.id, context: context)
            #expect(app.slackTriageProjectId == nil)
        }
    }
}

@Test @MainActor func slackTriageEntryChoicesKeepCollidingHostProjectsSeparate() throws {
    let app = try fixture()
    let client = PilotClient()
    client.loadFixture(projects: [project, Project(id: "no-slack", name: "Other", path: "/other", createdAt: 1)], sessions: [])
    try app.hosts.install(client, host: remote)
    let choices = SlackTriageInboxHeader.choices(hosts: app.hosts, model: app)
    #expect(choices.count == 2)
    #expect(Set(choices.map(\.id)).count == 2)
    #expect(Set(choices.map(\.title)) == ["Repository · Local", "Repository · devbox"])
    let header = SlackTriageInboxHeader.header(total: 0, choices: choices)
    #expect(header.linkTitle == "Open triage" && header.link == nil && header.linkChoices.count == 2)
    for choice in header.linkChoices {
        choice.action()
        let ref = try HostResourceRef.decodeKey(choice.id)
        #expect(app.slackTriageProjectId == (ref.host == local ? project.id : ref.storageKey))
        #expect(app.selectedProjectId == app.slackTriageProjectId)
    }
    let single = SlackTriageInboxHeader.header(total: 0, choices: [choices[0]])
    #expect(single.link != nil && single.linkChoices.isEmpty)
    single.link?()
    let none = SlackTriageInboxHeader.header(total: 0, choices: [])
    #expect(none.linkTitle == nil && none.link == nil && none.linkChoices.isEmpty)
}

@Test @MainActor func slackTriageEntryStaysAvailableForEmptyAndHiddenOnlyInboxes() throws {
    let app = try fixture()
    let inboxes = [
        Inbox(),
        Inbox(slack: InboxSlackSection(total: 0, items: [])),
        Inbox(slack: InboxSlackSection(total: 0, items: [], hidden: [.init(label: "Hidden", count: 3)])),
    ]
    for inbox in inboxes {
        #expect(inbox.isEmpty)
        let header = SlackTriageInboxHeader.header(total: inbox.slack?.total ?? 0,
            choices: SlackTriageInboxHeader.choices(hosts: app.hosts, model: app))
        #expect(header.linkTitle == "Open triage")
        #expect(header.linkChoices.isEmpty, "the only project opens directly")
        let open = try #require(header.link)
        app.showInbox()
        open()
        #expect(app.selectedProjectId == project.id && app.slackTriageProjectId == project.id)
        #expect(!app.showingInbox)
    }
}
