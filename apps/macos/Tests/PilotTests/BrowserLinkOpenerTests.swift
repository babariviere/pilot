import Foundation
import Testing
@testable import Pilot

@Test func heliumPRKeysIncludeSubpagesButNotOtherPRsOrHosts() throws {
    let variants = [
        "https://github.com/acme/app/pull/42",
        "https://GITHUB.com/ACME/App/pull/42/files?diff=split#diff-abc",
        "http://github.com/acme/app/pull/42/commits",
        "https://github.com/acme/app/pull/42#discussion_r123",
    ]
    for value in variants {
        #expect(BrowserLinkOpener.pullRequestKey(try #require(URL(string: value))) == "acme/app/pull/42")
    }
    for value in ["https://github.com/acme/app/pull/420", "https://github.com/other/app/pull/42"] {
        #expect(BrowserLinkOpener.pullRequestKey(try #require(URL(string: value))) != "acme/app/pull/42")
    }
    for value in ["https://github.com.evil.test/acme/app/pull/42", "https://github.com@evil.test/acme/app/pull/42",
                  "https://github.com/acme/app/issues/42", "file:///acme/app/pull/42",
                  "https://github.com/acme/app/pull/42oops", "https://github.com/acme/app/pull/0"] {
        #expect(BrowserLinkOpener.pullRequestKey(try #require(URL(string: value))) == nil)
    }
}

@Test @MainActor func heliumExistingTabAvoidsOpeningAndMissingTabFallsBack() async throws {
    let url = try #require(URL(string: "https://github.com/acme/app/pull/42"))
    var focused = true
    var keys: [String] = []
    var opened: [URL] = []
    let opener = BrowserLinkOpener(canLookup: { _ in true }, focus: {
        keys.append($0)
        return focused
    }, openNormally: { opened.append($0) })
    opener.open(url)
    await opener.task?.value
    #expect(keys == ["acme/app/pull/42"])
    #expect(opened.isEmpty)
    focused = false
    opener.open(url)
    await opener.task?.value
    #expect(opened == [url])
}

@Test @MainActor func heliumOtherBrowsersAndNonPRLinksBypassLookup() throws {
    var opened: [URL] = []
    let opener = BrowserLinkOpener(canLookup: { _ in false }, focus: { _ in
        Issue.record("Other browsers or stopped Helium must bypass lookup")
        return false
    }, openNormally: { opened.append($0) })
    let pr = try #require(URL(string: "https://github.com/acme/app/pull/42"))
    opener.open(pr)
    let other = BrowserLinkOpener(canLookup: { _ in
        Issue.record("Non-PR links must bypass browser detection")
        return true
    }, openNormally: { opened.append($0) })
    let issue = try #require(URL(string: "https://github.com/acme/app/issues/42"))
    other.open(issue)
    #expect(opened == [pr, issue])
}

@Test @MainActor func heliumRapidClicksCoalesceAndKeepOnlyLatestPendingPR() async throws {
    var finish: CheckedContinuation<Bool, Never>?
    var started: CheckedContinuation<Void, Never>?
    var keys: [String] = []
    var opened: [URL] = []
    let opener = BrowserLinkOpener(canLookup: { _ in true }, focus: { key in
        keys.append(key)
        if keys.count == 1 {
            return await withCheckedContinuation {
                finish = $0
                started?.resume()
            }
        }
        return false
    }, openNormally: { opened.append($0) })
    let first = try #require(URL(string: "https://github.com/acme/app/pull/42"))
    let next = try #require(URL(string: "https://github.com/acme/app/pull/43"))
    let latest = try #require(URL(string: "https://github.com/acme/app/pull/44"))
    await withCheckedContinuation { started = $0; opener.open(first) }
    opener.open(first)
    opener.open(next)
    opener.open(latest)
    finish?.resume(returning: false)
    await opener.task?.value
    #expect(keys == ["acme/app/pull/42", "acme/app/pull/44"])
    #expect(opened == [latest])
}

@Test func heliumScriptFocusesMatchingTabInAnotherMinimizedWindowWithoutNavigating() throws {
    // Synthetic scripting objects only. Never inspect the user's real browser tabs.
    let stub = #"""
    var activated = false;
    var windows = [
        {tabs: {url: function() {return ['https://github.com/acme/app/pull/420'];}}},
        {tabs: {url: function() {return ['https://example.com/', 'https://github.com/ACME/App/pull/42/files#diff-1'];}},
         activeTabIndex: 1, minimized: true, index: 2}
    ];
    function Application(id) {
        if (id !== 'net.imput.helium') throw new Error('Wrong browser');
        return {running: function() {return true;}, windows: function() {return windows;},
                activate: function() {activated = true;}};
    }
    """#
    let wrapped = stub + "\n" + HeliumTabLookup.script + #"""
    var lookup = run;
    run = function(argv) {
        var result = lookup(argv);
        if (result === 'focused' && activated && windows[1].activeTabIndex === 2 &&
            windows[1].minimized === false && windows[1].index === 1) return 'ok';
        if (result === 'not-found' && !activated) return 'missing';
        throw new Error('Unexpected focus behavior');
    };
    """#
    #expect(HeliumTabLookup.run(script: wrapped, arguments: ["acme/app/pull/42"]) == "ok")
    #expect(HeliumTabLookup.run(script: wrapped, arguments: ["other/app/pull/42"]) == "missing")
    #expect(HeliumTabLookup.run(script: wrapped, arguments: ["'); throw new Error('injected'); //"]) == "missing")
}

@Test func heliumScriptErrorsAndTimeoutsFailCleanly() {
    #expect(HeliumTabLookup.run(script: "function run() {throw new Error('Permission denied');}", arguments: []) == nil)
    let start = ContinuousClock.now
    #expect(HeliumTabLookup.run(script: "function run() {while (true) {}}", arguments: [], timeout: 0.2) == nil)
    #expect(start.duration(to: .now) < .seconds(2))
}
