import Foundation
import PilotPowerSupport
import Testing

struct PowerReplyReaderTests {
    @Test(.timeLimit(.minutes(1))) func shortReplyDoesNotWaitForFullBufferOrEOF() async throws {
        let pipe = Pipe()
        let input = pipe.fileHandleForReading
        let (events, continuation) = AsyncStream<ReplyEvent>.makeStream()
        defer { try? pipe.fileHandleForWriting.close() }
        // This is a deliberately blocking pipe reader. Give it its own thread rather than
        // waiting synchronously for a global-queue block that may not have been scheduled.
        let worker = Thread {
            let reader = PowerReplyReader(input: input)
            defer { continuation.finish() }
            for index in 0..<2 {
                continuation.yield(.reading(index))
                continuation.yield(.reply(index, reader.readReply()))
            }
            continuation.yield(.finished)
        }
        worker.start()
        var iterator = events.makeAsyncIterator()
        // Startup and later activity acknowledgements must both arrive while the guardian stays alive.
        for index in 0..<2 {
            let reading = await iterator.next()
            try #require(reading == .reading(index))
            try pipe.fileHandleForWriting.write(contentsOf: Data("{\"ok\":true}\n".utf8))
            let reply = await iterator.next()
            try #require(reply == .reply(index, true))
        }
        // Keep the writer open until both replies and worker completion. A full-buffer/EOF
        // regression cannot pass by having cleanup close the writer and release the read.
        let finished = await iterator.next()
        #expect(finished == .finished)
    }

    private enum ReplyEvent: Equatable, Sendable {
        case reading(Int), reply(Int, Bool), finished
    }

    @Test func retainsCoalescedRepliesBetweenRequests() throws {
        let pipe = Pipe()
        let reader = PowerReplyReader(input: pipe.fileHandleForReading)
        try pipe.fileHandleForWriting.write(contentsOf: Data("{\"ok\":true}\n{\"ok\":false}\n{\"ok\":true}\n".utf8))
        try pipe.fileHandleForWriting.close()
        #expect(reader.readReply())
        #expect(!reader.readReply())
        #expect(reader.readReply())
        #expect(!reader.readReply())
    }

    @Test func assemblesReplyAcrossBoundedReads() throws {
        let pipe = Pipe()
        let reader = PowerReplyReader(input: pipe.fileHandleForReading)
        let reply = String(repeating: " ", count: 6000) + "{\"ok\":true}\n"
        try pipe.fileHandleForWriting.write(contentsOf: Data(reply.utf8))
        try pipe.fileHandleForWriting.close()
        #expect(reader.readReply())
    }

    @Test func rejectsMalformedTruncatedAndOversizedReplies() throws {
        for reply in ["not json\n", "{}\n", "{\"ok\":false}\n", "{\"ok\":true}", "", String(repeating: "x", count: 8193)] {
            let pipe = Pipe()
            let reader = PowerReplyReader(input: pipe.fileHandleForReading)
            // Keep fixtures below pipe capacity; EOF also makes all failure cases bounded.
            try pipe.fileHandleForWriting.write(contentsOf: Data(reply.utf8))
            try pipe.fileHandleForWriting.close()
            #expect(!reader.readReply())
        }
    }
}
