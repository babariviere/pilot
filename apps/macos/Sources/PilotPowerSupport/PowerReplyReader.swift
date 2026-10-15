import Darwin
import Foundation

/// Bounded newline replies on a long-lived guardian pipe. Used only by the serial work queue.
public final class PowerReplyReader {
    private let input: FileHandle
    private var buffer = Data()

    public init(input: FileHandle) { self.input = input }

    public func readReply() -> Bool {
        while !buffer.contains(10) {
            var bytes = [UInt8](repeating: 0, count: 4096)
            // FileHandle.read(upToCount:) can wait for the entire count or EOF on macOS.
            // A POSIX pipe read returns the bytes available, without waiting for the next reply.
            let count = Darwin.read(input.fileDescriptor, &bytes, bytes.count)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { return false }
            buffer.append(contentsOf: bytes.prefix(count))
            guard buffer.count <= 8192 else { return false }
        }
        let newline = buffer.firstIndex(of: 10)!
        let line = buffer.prefix(upTo: newline)
        buffer.removeSubrange(...newline)
        return (try? JSONSerialization.jsonObject(with: line) as? [String: Any])?["ok"] as? Bool == true
    }
}
