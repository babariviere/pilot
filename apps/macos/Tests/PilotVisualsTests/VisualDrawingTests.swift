import Foundation
import PilotVisualsKit
import Testing

struct VisualDrawingTests {
    static let sample = VisualDrawing(
        commands: 12,
        ops: [
            1, 3, 10, 20, 4, 0.5, 5, 2, 3, 6, 0.25,
            10, 1, 7, 0.5, 0, 0, 0, 30, 20, 4,
            11, 2, 2, 1, 1.5, 5, 5, 3,
            12, 2, 1, 1, 2, 0, 0, 10, 10,
            13, 1, 12, 1, 0, 1, 2, 0, 0, 5, 5,
            14, 1, 3, 1, 0, 0, 0, 10, 4, 0, 3.14,
            20, 0, 1, 2, 3, 0, 4, 600, 1, 2, 1,
            2,
        ],
        strings: ["héllo 👋"])

    @Test func roundTripsAndWalksEveryCommand() throws {
        let decoded = try #require(VisualDrawing(Self.sample.encoded))
        #expect(decoded == Self.sample)
        var commands: [VisualDrawing.Command] = []
        #expect(decoded.forEach { commands.append($0) })
        #expect(commands.count == Self.sample.commands)
        #expect(commands[0] == .save)
        #expect(commands[1] == .translate(x: 10, y: 20))
        #expect(commands[2] == .rotate(0.5))
        #expect(commands[3] == .scale(x: 2, y: 3))
        #expect(commands[4] == .opacity(0.25))
        guard case .rect(let fill, 0, 0, 30, 20, 4) = commands[5] else { Issue.record("rect"); return }
        #expect(fill == VisualDrawing.Paint(stroke: false, color: 7, opacity: 0.5, lineWidth: 0))
        guard case .circle(let stroke, 5, 5, 3) = commands[6] else { Issue.record("circle"); return }
        #expect(stroke == VisualDrawing.Paint(stroke: true, color: 2, opacity: 1, lineWidth: 1.5))
        guard case .line(_, 0, 0, 10, 10) = commands[7] else { Issue.record("line"); return }
        guard case .path(_, true, let points) = commands[8] else { Issue.record("path"); return }
        #expect(Array(points) == [0, 0, 5, 5])
        guard case .arc(_, 0, 0, 10, 4, 0, 3.14) = commands[9] else { Issue.record("arc"); return }
        guard case .text(let text) = commands[10] else { Issue.record("text"); return }
        #expect(text.string == "héllo 👋")
        #expect(text.x == 2 && text.y == 3 && text.size == 4 && text.weight == 600 && text.align == 1)
        #expect(text.baseline == 2 && text.mono)
        #expect(commands[11] == .restore)
    }

    @Test func rejectsMalformedBytes() {
        let data = Self.sample.encoded
        #expect(VisualDrawing(Data()) == nil)
        #expect(VisualDrawing(data.prefix(30)) == nil)
        #expect(VisualDrawing(data + Data([0])) == nil)
        var wrongVersion = data
        wrongVersion[2] = 2
        #expect(VisualDrawing(wrongVersion) == nil)
        var hugeCount = data
        hugeCount.replaceSubrange(8..<12, with: [0xff, 0xff, 0xff, 0x7f])
        #expect(VisualDrawing(hugeCount) == nil)
        #expect(VisualDrawing.isDrawing(data))
        #expect(!VisualDrawing.isDrawing(VisualReply.error(.script, "boom")))
    }

    @Test func stopsAtTheFirstMalformedCommand() {
        func walk(_ ops: [Double], strings: [String] = []) -> (Bool, Int) {
            var count = 0
            let complete = VisualDrawing(commands: 0, ops: ops, strings: strings).forEach { _ in count += 1 }
            return (complete, count)
        }
        #expect(walk([1, 99]) == (false, 1))
        #expect(walk([1, 10, 1, 13, 1, 0, 0, 0, 1, 1]) == (false, 1), "color index out of range")
        #expect(walk([3, 1]) == (false, 0), "truncated")
        #expect(walk([11, 1, 0, 1, 0, 0, .nan, 1]) == (false, 0), "not finite")
        #expect(walk([13, 1, 0, 1, 0, 0, 1e9, 1, 1]) == (false, 0), "path longer than the ops")
        #expect(walk([13, 1, 0, 1, 0, 0, 1.5, 1, 1, 2, 2]) == (false, 0), "fractional point count")
        #expect(walk([20, 0, 1, 0, 0, 3, 0, 400, 0, 0, 0], strings: ["a"]) == (false, 0), "string index")
        #expect(walk([2, 2, 1]) == (true, 3))
    }
}
