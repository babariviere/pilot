import Foundation

/// Streaming Markdown cost per update: a full parse of the whole reply (the old path) against MarkdownStream,
/// both followed by inline AttributedString parsing of the blocks they would prepare, like MarkdownRenderer.
///
///   xcrun swiftc -O -parse-as-library apps/macos/scripts/bench-markdown.swift \
///     apps/macos/Sources/PilotCore/Markdown.swift -o /tmp/pilot-markdown-bench && /tmp/pilot-markdown-bench
@main
struct MarkdownBench {
    static func main() {
        var reply = ""
        var section = 0
        while reply.utf8.count < 24000 {
            section += 1
            reply += """
            ## Step \(section): what changed

            The session list re-sorted on **every** update, so a restarting worker jumped. The comparison used \
            `updatedAt`, see [the issue](https://example.com/\(section)).

            1. Sort by `lastActivityAt`.
            2. Keep pinned first.
            3. Add a test.

            - Restarts no longer reorder.
            - Archived chats keep their position.

            ```swift
            static func listPrecedes(_ lhs: S, _ rhs: S) -> Bool {
                if lhs.pinned != rhs.pinned { return lhs.pinned }
                return lhs.at > rhs.at
            }
            ```

            | Case | Before | After |
            | --- | --- | --- |
            | Restart | Top | Stays |

            > Only user-visible activity changes the order now.


            """
        }
        let characters = Array(reply)
        for chunk in [12, 100] {
            var prefixes: [String] = []
            var end = 0
            while end < characters.count {
                end = min(characters.count, end + chunk)
                prefixes.append(String(characters[0 ..< end]))
            }
            var sink = 0
            let clock = ContinuousClock()
            let full = clock.measure {
                for prefix in prefixes { sink &+= inlineCost(Markdown.parse(prefix)[...]) }
            }
            let incremental = clock.measure {
                var stream = MarkdownStream()
                var prepared = 0
                for prefix in prefixes {
                    stream.update(prefix)
                    sink &+= inlineCost(stream.stableBlocks[prepared...])
                    prepared = stream.stableBlocks.count
                    sink &+= inlineCost(stream.tailBlocks[...])
                }
            }
            func perUpdate(_ duration: Duration) -> String {
                let ms = Double(duration.components.seconds) * 1000 + Double(duration.components.attoseconds) / 1e15
                return String(format: "%.3f ms/update (%.0f ms total)", ms / Double(prefixes.count), ms)
            }
            print("\(chunk)-character deltas, \(prefixes.count) updates of a \(reply.utf8.count) B reply: "
                  + "full parse \(perUpdate(full)), incremental \(perUpdate(incremental)) [\(sink % 2)]")
        }
    }

    static func inlineCost(_ blocks: ArraySlice<MarkdownBlock>) -> Int {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        func parse(_ text: String) -> Int { (try? AttributedString(markdown: text, options: options))?.characters.count ?? 0 }
        var count = 0
        for block in blocks {
            switch block {
            case let .heading(_, text), let .paragraph(text), let .quote(text): count += parse(text)
            case let .list(_, _, items): for item in items { count += parse(item) }
            default: break
            }
        }
        return count
    }
}

