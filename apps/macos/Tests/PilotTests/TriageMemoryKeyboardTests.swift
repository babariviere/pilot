import Foundation
import Testing
@testable import Pilot

@Test func triageAndMemoryKeysAreInTheShortcutReferenceWithoutLetterActions() {
    let groups = Dictionary(uniqueKeysWithValues: KeyboardShortcuts.groups.map { ($0.title, $0.entries) })
    let lists = Dictionary(uniqueKeysWithValues: (groups["Lists and boards"] ?? []).map { ($0.title, $0.keys) })
    #expect(lists["Move between Slack messages and columns"] == "↑ ↓ ← →")
    #expect(lists["Fold or unfold in Memory"] == "← / →")
    // Type, label and dismiss are inspector controls and ⌘K actions, never T, L or D.
    let keys = KeyboardShortcuts.groups.flatMap(\.entries).map(\.keys)
    #expect(!keys.contains { ["T", "L", "D", "E"].contains($0) })
    // Every entry stays unique across groups, so search and VoiceOver read one row per action.
    let titles = KeyboardShortcuts.groups.flatMap(\.entries).map(\.title)
    #expect(Set(titles).count == titles.count)
}

/// Plain letters reach the board and its search unchanged: nothing routes or consumes them.
@Test func triageLettersAreNotTakenByNavigation() {
    for letter in ["t", "l", "d", "g", "j", "k"] {
        #expect(KeyboardRoute.decide(KeyboardChord(characters: letter), context: .navigation) == .pass)
    }
    #expect(KeyboardRoute.decide(KeyboardChord(characters: "t"), context: .text) == .pass,
            "typing in the triage search never edits a message")
}
