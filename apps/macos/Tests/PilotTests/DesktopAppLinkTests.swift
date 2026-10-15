import Foundation
import Testing
@testable import Pilot

@Test func desktopLinksPreserveLinearIssueProjectAndCommentDestinations() throws {
    for value in [
        "https://linear.app/acme/issue/ENG-42/fix-export?view=all#comment-123",
        "http://linear.app/acme/project/api-v2-0123456789ab/overview",
        "https://LINEAR.app/acme/issue/ENG-42/a%20title",
    ] {
        let web = try #require(URL(string: value))
        let native = try #require(DesktopAppLink.url(for: web))
        var expected = try #require(URLComponents(url: web, resolvingAgainstBaseURL: false))
        expected.scheme = "linear"
        #expect(native == expected.url)
        #expect(BrowserLinkOpener.handles(web))
    }
}

@Test func desktopSlackLinksKeepChannelMessageThreadAndWorkspace() throws {
    // Slack ignores slack://channel without a team and only scrolls to `message`, not `ts`.
    let workspaces = [SlackWorkspace(id: "T123", host: "acme.slack.com"),
                      SlackWorkspace(id: "E456", host: "corp.enterprise.slack.com")]
    let cases: [(String, String)] = [
        ("https://acme.slack.com/archives/C123/p1791885305000001",
         "slack://channel?team=T123&id=C123&message=1791885305.000001"),
        ("https://ACME.slack.com/archives/C123/p1791885305000001?thread_ts=1791885000.000002&cid=C123",
         "slack://channel?team=T123&id=C123&message=1791885305.000001&thread_ts=1791885000.000002"),
        ("https://other.slack.com/archives/C123?thread_ts=1791885000.000002&team=T999",
         "slack://channel?team=T999&id=C123&message=1791885000.000002&thread_ts=1791885000.000002"),
        ("https://corp.enterprise.slack.com/archives/G123",
         "slack://channel?team=E456&id=G123"),
        ("https://app.slack.com/client/T123/D123/1791885305.000001",
         "slack://channel?team=T123&id=D123&message=1791885305.000001"),
        ("https://app.slack.com/client/E123/C123",
         "slack://channel?team=E123&id=C123"),
    ]
    for (web, native) in cases {
        let url = try #require(URL(string: web))
        #expect(DesktopAppLink.url(for: url, slackWorkspaces: { workspaces })?.absoluteString == native)
    }
}

@Test func desktopSlackLinksWithoutKnownWorkspaceStayInBrowser() throws {
    let one = [SlackWorkspace(id: "T123", host: "acme.slack.com")]
    let two = one + [SlackWorkspace(id: "T456", host: "beta.slack.com")]
    let bare = try #require(URL(string: "https://slack.com/archives/C123/p1000001"))
    // A bare slack.com permalink is unambiguous only when one workspace is signed in.
    #expect(DesktopAppLink.url(for: bare, slackWorkspaces: { one })?.absoluteString
        == "slack://channel?team=T123&id=C123&message=1.000001")
    #expect(DesktopAppLink.url(for: bare, slackWorkspaces: { two }) == nil)
    #expect(DesktopAppLink.url(for: bare, slackWorkspaces: { [] }) == nil)
    let unknown = try #require(URL(string: "https://gamma.slack.com/archives/C123/p1791885305000001"))
    #expect(DesktopAppLink.url(for: unknown, slackWorkspaces: { two }) == nil)
}

@Test func slackDesktopStateReadsSignedInWorkspaces() throws {
    let json = #"""
    {"workspaces":{
      "T123":{"id":"T123","domain":"acme","url":"https://acme.slack.com/","name":"Acme"},
      "T456":{"id":"T456","domain":"Beta"},
      "bad":{"id":"not-an-id","url":"https://evil.slack.com/"}
    },"teams":{}}
    """#
    #expect(SlackDesktopState.workspaces(rootState: Data(json.utf8)) == [
        SlackWorkspace(id: "T123", host: "acme.slack.com"),
        SlackWorkspace(id: "T456", host: "beta.slack.com"),
    ])
    #expect(SlackDesktopState.workspaces(rootState: Data("[]".utf8)).isEmpty)
}

@Test func desktopLinksRejectUnrelatedUnsafeOrMalformedURLs() throws {
    for value in [
        "https://linear.app/", "https://linear.app/login", "https://linear.app/features",
        "https://linear.app/acme/issue", "https://linear.app.evil.test/acme/issue/ENG-42",
        "https://linear.app@evil.test/acme/issue/ENG-42", "https://evil.test@linear.app/acme/issue/ENG-42",
        "https://linear.app:8443/acme/issue/ENG-42", "file://linear.app/acme/issue/ENG-42",
        "https://slack.com/help", "https://acme.slack.com/signin", "https://notslack.com/archives/C123",
        "https://acme.slack.com.evil.test/archives/C123", "https://evil.test@acme.slack.com/archives/C123",
        "https://acme.slack.com/archives/random", "https://slack.com/archives/C123/p1",
        "https://slack.com/archives/C123/p1791885305oops01", "https://slack.com/archives/C123/p1791885305000001/more",
        "https://slack.com/archives/C123?team=not-an-id", "https://slack.com/archives/C123?thread_ts=bad",
        "https://app.slack.com/client/T123/C123/not-a-timestamp", "https://app.slack.com/client/not-a-team/C123",
        "https://example.test/client/T123/C123", "slack://channel?id=C123", "linear://linear.app/acme/issue/ENG-42",
    ] {
        let url = try #require(URL(string: value))
        #expect(DesktopAppLink.url(for: url) == nil, "\(value)")
        #expect(!BrowserLinkOpener.handles(url), "\(value)")
    }
}

@Test @MainActor func desktopAppHandoffAvoidsBrowserAndUnavailableAppFallsBackToOriginalURL() throws {
    for service in ["https://linear.app/acme/issue/ENG-42/title#comment-1",
                    "https://slack.com/archives/C123/p1791885305000001?team=T123"] {
        let web = try #require(URL(string: service))
        let native = try #require(DesktopAppLink.url(for: web))
        var desktopAvailable = true
        var attempts: [URL] = []
        var browser: [URL] = []
        let opener = BrowserLinkOpener(canLookup: { _ in
            Issue.record("Service links must not inspect browser tabs")
            return false
        }, openNormally: { browser.append($0) }, openDesktop: {
            attempts.append($0)
            return desktopAvailable
        })
        opener.open(web)
        #expect(attempts == [native])
        #expect(browser.isEmpty)
        #expect(opener.task == nil)
        // Both a missing scheme handler and a failed launch return false.
        desktopAvailable = false
        opener.open(web)
        #expect(attempts == [native, native])
        #expect(browser == [web])
    }
}

@Test @MainActor func desktopOpenerLeavesOtherLinksAlone() throws {
    var opened: [URL] = []
    let opener = BrowserLinkOpener(canLookup: { _ in false }, openNormally: { opened.append($0) }, openDesktop: { _ in
        Issue.record("Unrelated links must not launch a service app")
        return true
    })
    let web = try #require(URL(string: "https://example.test/help"))
    opener.open(web)
    #expect(opened == [web])
}

@Test @MainActor func desktopClickSupersedesPendingBrowserFallback() async throws {
    var finish: CheckedContinuation<Bool, Never>?
    var started: CheckedContinuation<Void, Never>?
    var browser: [URL] = []
    var desktop: [URL] = []
    let opener = BrowserLinkOpener(canLookup: { _ in true }, focus: { _ in
        await withCheckedContinuation {
            finish = $0
            started?.resume()
        }
    }, openNormally: { browser.append($0) }, openDesktop: { desktop.append($0); return true })
    let pr = try #require(URL(string: "https://github.com/acme/app/pull/42"))
    let linear = try #require(URL(string: "https://linear.app/acme/issue/ENG-42"))
    let native = try #require(DesktopAppLink.url(for: linear))
    await withCheckedContinuation { started = $0; opener.open(pr) }
    opener.open(linear)
    finish?.resume(returning: false)
    await opener.task?.value
    #expect(browser.isEmpty)
    #expect(desktop == [native])
}
