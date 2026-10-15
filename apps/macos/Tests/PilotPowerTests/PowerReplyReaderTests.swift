import Foundation
import PilotPowerSupport
import Testing

struct PowerReplyReaderTests {
    @Test func shortReplyDoesNotWaitForFullBufferOrEOF() throws {
        let pipe = Pipe()
        let reader = PowerReplyReader(input: pipe.fileHandleForReading)
        let received = DispatchSemaphore(value: 0)
        let finished = DispatchSemaphore(value: 0)
        defer {
            try? pipe.fileHandleForWriting.close()
            #expect(finished.wait(timeout: .now() + 2) == .success)
        }
        DispatchQueue.global().async {
            for _ in 0..<2 {
                if reader.readReply() { received.signal() }
            }
            finished.signal()
        }
        // Startup and later activity acknowledgements must both arrive while the guardian stays alive.
        for _ in 0..<2 {
            try pipe.fileHandleForWriting.write(contentsOf: Data("{\"ok\":true}\n".utf8))
            #expect(received.wait(timeout: .now() + 2) == .success)
        }
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
