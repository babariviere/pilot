import AppKit
import Testing
@testable import Pilot

@Test func streamedChunksSplitIntoContiguousWordRuns() {
    let text = "The session list resorted on every update, so a restarting worker jumped to the top." as NSString
    let range = NSRange(location: 4, length: text.length - 4)
    let segments = StreamPacing.segments(of: text, in: range)
    #expect(segments.count > 1 && segments.count <= StreamPacing.maxSegments)
    // Together they cover the new text exactly, in order, with no gaps or overlaps.
    #expect(segments.first?.location == range.location)
    #expect(segments.last.map(NSMaxRange) == NSMaxRange(range))
    for (a, b) in zip(segments, segments.dropFirst()) { #expect(NSMaxRange(a) == b.location) }
    // Every run after the first starts at a word, never inside one.
    for segment in segments.dropFirst() {
        let previous = text.character(at: segment.location - 1)
        #expect(previous == UInt16(UInt8(ascii: " ")), "cut inside a word at \(segment.location)")
    }
}

@Test func shortOrUnbrokenChunksStayOneRun() {
    let word = "Supercalifragilistic" as NSString
    #expect(StreamPacing.segments(of: word, in: NSRange(location: 0, length: word.length)).count == 1)
    let short = "Hi there" as NSString
    #expect(StreamPacing.segments(of: short, in: NSRange(location: 3, length: 5)) == [NSRange(location: 3, length: 5)])
    #expect(StreamPacing.segments(of: short, in: NSRange(location: 0, length: 0)).isEmpty)
    let long = String(repeating: "word ", count: 400) as NSString
    #expect(StreamPacing.segments(of: long, in: NSRange(location: 0, length: long.length)).count == StreamPacing.maxSegments)
}

@Test func paceSpreadsOverOneIntervalAndShrinksForFasterStreams() {
    #expect(StreamPacing.pacing(sinceLastFade: nil) == Theme.Motion.streamedTextPacing)
    #expect(StreamPacing.pacing(sinceLastFade: 0.29) == Theme.Motion.streamedTextPacing, "pilotd's 4 updates a second")
    #expect(abs(StreamPacing.pacing(sinceLastFade: 0.1) - 0.08) < 0.000_001, "faster updates, shorter pace")
    let delays = StreamPacing.delays(count: 5, pacing: 0.2)
    #expect(delays.first == 0)
    #expect(zip(delays, delays.dropFirst()).allSatisfy { $0 < $1 })
    #expect((delays.last ?? 1) < 0.2)
    #expect(StreamPacing.delays(count: 1, pacing: 0.2) == [0])
    // The last run finishes before about two intervals, so chunks flow into each other without piling up.
    #expect(Theme.Motion.streamedTextPacing + Theme.Motion.streamedSegmentFade < 0.5)
}
