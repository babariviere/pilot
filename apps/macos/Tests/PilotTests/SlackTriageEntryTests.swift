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
    try loadClientFixture(app.client, host: local, into: app.hosts)
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
    try loadClientFixture(client, host: remote, into: app.hosts)
    let choices = SlackTriageInboxHeader.choices(hosts: app.hosts, model: app)
    #expect(choices.count == 2)
    #expect(Set(choices.map(\.id)).count == 2)
    #expect(Set(choices.map(\.id)) == Set([local, remote].map {
        HostResourceRef(host: $0, kind: .project, localId: project.id).storageKey
    }))
    // Non-Local fixtures retain an explicit alias, not a live devbox display name.
    #expect(Set(choices.map(\.title)) == ["Repository · Local", "Repository · legacy-fixture"])
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

@Test @MainActor func slackTriageEntryOnlyLabelsAmbiguousProjectNames() throws {
    let app = try fixture()
    let client = PilotClient()
    let tools = Project(id: "tools", name: "Dev tools", path: "/tools",
                        tracking: .init(slackChannels: ["C2"]), createdAt: 1)
    let untracked = Project(id: "untracked", name: project.name, path: "/untracked", createdAt: 1)
    client.loadFixture(projects: [tools, untracked], sessions: [])
    try loadClientFixture(client, host: remote, into: app.hosts)
    var choices = SlackTriageInboxHeader.choices(hosts: app.hosts, model: app)
    #expect(choices.map(\.title) == ["Dev tools", "Repository"], "untracked projects do not cause ambiguity")
    for choice in choices {
        choice.action()
        let ref = try HostResourceRef.decodeKey(choice.id)
        let selected = try #require(app.selectedProjectId)
        #expect(app.resourceRef(selected, kind: .project) == ref,
                "a shorter label never changes the destination")
    }

    let duplicate = Project(id: project.id, name: "repository", path: "/remote-repo",
                            tracking: .init(slackChannels: ["C3"]), createdAt: 1)
    let replacement = PilotClient()
    replacement.loadFixture(projects: [tools, duplicate], sessions: [])
    try loadClientFixture(replacement, host: remote, into: app.hosts)
    choices = SlackTriageInboxHeader.choices(hosts: app.hosts, model: app)
    #expect(Set(choices.map(\.title)) == ["Dev tools", "Repository · Local", "repository · legacy-fixture"],
            "only duplicate names need hosts, including names differing only by case")
    #expect(choices.count == 3 && Set(choices.map(\.id)).count == 3)
    for choice in choices {
        choice.action()
        let ref = try HostResourceRef.decodeKey(choice.id)
        let selected = try #require(app.selectedProjectId)
        #expect(app.resourceRef(selected, kind: .project) == ref,
                "adding an ambiguity label never changes the qualified destination")
    }
}
