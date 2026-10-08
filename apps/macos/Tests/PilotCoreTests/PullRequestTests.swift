import Foundation
import Testing
@testable import PilotCore

private let oldSessionJSON = #"{"id":"s","title":"Task","cwd":"/tmp","createdAt":1,"updatedAt":2,"state":"idle"}"#

private func pr(_ state: PullRequestState = .open, url: String = "https://github.com/example/repo/pull/7") -> SessionPullRequest {
    SessionPullRequest(number: 7, url: url, title: "Add PR indicators", state: state, checkedAt: 1_781_524_800_000)
}

@Test func pullRequestWireFieldsAreOptional() throws {
    let old = try JSONDecoder().decode(SessionSummary.self, from: Data(oldSessionJSON.utf8))
    #expect(old.pullRequest == nil)
    #expect(old.pullRequestError == nil)
    #expect(old.pullRequestHelpText == nil)
    #expect(!old.pullRequestIsStale)
    let nullFields = oldSessionJSON.dropLast() + #", "pullRequest":null, "pullRequestError":null}"#
    #expect(try JSONDecoder().decode(SessionSummary.self, from: Data(nullFields.utf8)) == old)
}

@Test func pullRequestStatesDecodeAndRoundTripAlongsideUsageAndOutcome() throws {
    for state in PullRequestState.allCases {
        let json = oldSessionJSON.dropLast() + """
        , "pullRequest":{"number":7,"url":"https://github.com/example/repo/pull/7","title":"Add PR indicators","state":"\(state.rawValue)","checkedAt":1781524800000},
        "pullRequestError":"Rate limited", "outcome":"needs_input","outcomeAt":100,"outcomeReason":"Choose a provider",
        "usage":{"context":{"contextWindow":200000,"tokens":1000}}}
        """
        let decoded = try JSONDecoder().decode(SessionSummary.self, from: Data(json.utf8))
        #expect(decoded.pullRequest == pr(state))
        #expect(decoded.pullRequestError == "Rate limited")
        #expect(decoded.outcome == .done)
        #expect(decoded.status == .done)
        #expect(decoded.visibleOutcomeAt == 100)
        #expect(decoded.usage?.context?.tokens == 1000)
        #expect(try JSONDecoder().decode(SessionSummary.self, from: JSONEncoder().encode(decoded)) == decoded)
    }
}

@Test func pullRequestLabelsAreSeparateFromAgentStatus() {
    #expect(PullRequestState.allCases.map(\.label) == ["Draft", "Open", "Merged", "Closed without merging"])
    #expect(pr(.closed).label == "Closed without merging #7")
    #expect(pr(.closed).compactLabel == "Closed #7")
    #expect(pr(.closed).state != .merged)
    #expect(pr(.merged).label == "Merged #7")
    let session = SessionSummary(id: "s", title: "Task", cwd: "/tmp", createdAt: 1, updatedAt: 2,
                                 state: "working", outcome: .done, outcomeAt: 100, pullRequest: pr(.merged))
    #expect(session.status == .working)
    #expect(session.visibleOutcomeAt == nil)
    #expect(session.pullRequest?.state == .merged)
}

@Test func pullRequestBrowserURLsAllowEnterpriseButNotOtherSchemes() {
    for url in ["https://github.com/example/repo/pull/7", "https://github.acme.test/team/repo/pull/7",
                "http://github.local/team/repo/pull/7", "HTTPS://github.acme.test/team/repo/pull/7"] {
        #expect(pr(url: url).browserURL != nil)
    }
    for url in ["file:///tmp/repo", "javascript:alert(1)", "mailto:someone@example.com", "pilot://repo/pull/7",
                "https:///", "https://", "/relative/pull/7", "//github.com/repo/pull/7", "",
                "https://user:secret@github.com/example/repo/pull/7"] {
        #expect(pr(url: url).browserURL == nil)
    }
}

@Test func pullRequestLookupErrorsAreLastKnownNotFresh() {
    let session = SessionSummary(id: "s", title: "Task", cwd: "/tmp", createdAt: 1, updatedAt: 2,
                                 state: "idle", pullRequest: pr(), pullRequestError: "Network offline")
    #expect(session.pullRequestIsStale)
    #expect(session.pullRequest?.checkedDate == Date(timeIntervalSince1970: 1_781_524_800))
    #expect(session.pullRequestHelpText?.contains("Last known: Open #7") == true)
    #expect(session.pullRequestHelpText?.contains("Last checked:") == true)
    #expect(session.pullRequestHelpText?.contains("Cached status may be out of date.") == true)
    #expect(session.pullRequestHelpText?.contains("Network offline") == true)
    let missing = SessionSummary(id: "s", title: "Task", cwd: "/tmp", createdAt: 1, updatedAt: 2,
                                 state: "idle", pullRequestError: "Not authenticated")
    #expect(missing.pullRequestHelpText?.contains("No cached status available.") == true)
    let fresh = SessionSummary(id: "s", title: "Task", cwd: "/tmp", createdAt: 1, updatedAt: 2,
                               state: "idle", pullRequest: pr(url: "file:///tmp"))
    #expect(!fresh.pullRequestIsStale)
    #expect(fresh.pullRequestHelpText?.contains("Last known") == false)
    #expect(fresh.pullRequestHelpText?.contains("Invalid pull request link") == true)
    #expect(SessionPullRequest(number: 7, url: "", title: "", state: .open, checkedAt: .nan).checkedDate == nil)
}
