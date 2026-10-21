import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func remoteBadgeNamesItsHostAndNeverMarksLocalChats() {
    let hosts = ClientDirectory()
    let local = HostRef(hostId: "local", daemonId: "local-daemon", lineageId: "history")
    let remote = HostRef(hostId: "personal-box", daemonId: "remote-daemon", lineageId: "history")
    #expect(RemoteChatBadgeText(context: nil) == nil)
    #expect(RemoteChatBadgeText(context: HostViewContext(host: local, hosts: hosts)) == nil)
    let text = RemoteChatBadgeText(context: HostViewContext(host: remote, hosts: hosts))
    #expect(text?.label == "Remote")
    #expect(text?.help == "Runs on personal-box")
    #expect(text?.accessibilityLabel == "Remote chat on personal-box")
}

@Test @MainActor func remoteBadgeSurvivesDisconnectWithoutChangingTheAgentState() async throws {
    let hosts = ClientDirectory()
    let remote = HostRef(hostId: "personal-box", daemonId: "remote-daemon", lineageId: "history")
    let context = HostViewContext(host: remote, hosts: hosts)
    let client = PilotClient()
    let session = SessionSummary(id: "same", title: "Chat", cwd: "/repo", createdAt: 0, updatedAt: 0, state: "working")
    client.loadFixture(projects: [], sessions: [session])
    try loadClientFixture(client, host: remote, into: hosts)
    let connected = RemoteChatBadgeText(context: context)
    await hosts.disconnect(remote)
    #expect(RemoteChatBadgeText(context: context) == connected)
    #expect(hosts.sessions.first?.value.state == "working")
}
