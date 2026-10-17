import Foundation
import Testing
@testable import Pilot

@Test func triageAndMemoryKeysAreInTheShortcutReference() {
    let groups = Dictionary(uniqueKeysWithValues: KeyboardShortcuts.groups.map { ($0.title, $0.entries) })
    let triage = Dictionary(uniqueKeysWithValues: (groups["Slack triage"] ?? []).map { ($0.title, $0.keys) })
    #expect(triage["Change type"] == "T")
    #expect(triage["Change label"] == "L")
    #expect(triage["Dismiss or restore"] == "D")
    #expect(groups["Memory"]?.isEmpty == false)
    // Every entry stays unique across groups, so search and VoiceOver read one row per action.
    let titles = KeyboardShortcuts.groups.flatMap(\.entries).map(\.title)
    #expect(Set(titles).count == titles.count)
}

/// Plain letters reach the board as before: only G starts a sequence, and J/K become arrows.
@Test func triageLettersAreNotTakenByNavigation() {
    for letter in ["t", "l", "d"] {
        #expect(KeyboardRoute.decide(KeyboardChord(characters: letter), context: .navigation, pending: false) == .pass)
    }
    #expect(KeyboardRoute.decide(KeyboardChord(characters: "t"), context: .text, pending: false) == .pass,
            "typing in the triage search never edits a message")
}
