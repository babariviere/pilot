import Testing
@testable import PilotCore

@Test func transcriptInitiallyFollowsOutput() {
    let follow = TranscriptScrollFollow()
    #expect(follow.shouldScrollToBottom)
}

@Test func messageExpansionPausesFollowUntilUserReturnsToBottom() {
    var follow = TranscriptScrollFollow()
    follow.pauseFollowing()
    #expect(!follow.shouldScrollToBottom && !follow.isUserScrolling)
    follow.endUserScroll(distanceToBottom: 100)
    #expect(!follow.shouldScrollToBottom)
    follow.endUserScroll(distanceToBottom: 0)
    #expect(follow.shouldScrollToBottom)
}

@Test func scrollingUpSuspendsFollowBeforeTheViewportMoves() {
    var follow = TranscriptScrollFollow()
    follow.beginUserScroll()
    #expect(!follow.shouldScrollToBottom)
    follow.userScrolled(distanceToBottom: 120)
    follow.endUserScroll(distanceToBottom: 120)
    #expect(!follow.isUserScrolling)
    // Every subsequent transcript update keeps the reader's position.
    #expect(!follow.shouldScrollToBottom)
}

@Test func returningToBottomResumesOnlyAfterTheGestureEnds() {
    var follow = TranscriptScrollFollow()
    follow.beginUserScroll()
    follow.userScrolled(distanceToBottom: 300)
    follow.userScrolled(distanceToBottom: 0)
    #expect(!follow.shouldScrollToBottom)
    follow.endUserScroll(distanceToBottom: 0)
    #expect(follow.shouldScrollToBottom)
}

@Test func legacyMouseWheelScrollsDoNotRequireGestureNotifications() {
    var follow = TranscriptScrollFollow()
    follow.userScrolled(distanceToBottom: 80)
    #expect(!follow.shouldScrollToBottom)
    follow.userScrolled(distanceToBottom: 20)
    #expect(!follow.shouldScrollToBottom)
    follow.userScrolled(distanceToBottom: 0)
    #expect(follow.shouldScrollToBottom)
}

@Test func bottomToleranceHandlesRoundingAndOverscroll() {
    var follow = TranscriptScrollFollow()
    follow.userScrolled(distanceToBottom: 3)
    #expect(!follow.shouldScrollToBottom)
    follow.userScrolled(distanceToBottom: 1.5)
    #expect(follow.shouldScrollToBottom)
    follow.userScrolled(distanceToBottom: -10)
    #expect(follow.shouldScrollToBottom)
}

@Test func endingAScrollUsesTheLatestBottomDistance() {
    var follow = TranscriptScrollFollow()
    follow.beginUserScroll()
    follow.userScrolled(distanceToBottom: 0)
    // Output may have grown while auto-follow was suspended during the gesture.
    follow.endUserScroll(distanceToBottom: 40)
    #expect(!follow.shouldScrollToBottom)
}
