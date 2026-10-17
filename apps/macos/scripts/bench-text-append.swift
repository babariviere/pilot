import AppKit

/// TextKit cost of streaming into one text block: replacing the whole storage per update (the old path)
/// against editing only the changed tail, each followed by layout at a fixed width, as the transcript measures, and
/// the tail edit plus the fade-in veils for the new text, at once or paced by word run (main-thread cost only; Core
/// Animation plays the fade).
///
///   xcrun swiftc -O -parse-as-library apps/macos/scripts/bench-text-append.swift -o /tmp/pilot-text-bench \
///     && /tmp/pilot-text-bench
@main
struct TextAppendBench {
    static func main() {
        let font = NSFont.systemFont(ofSize: 14)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 3
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.labelColor,
                                                         .paragraphStyle: paragraph]
        let sentence = "The session list re-sorted on every update, so a restarting worker briefly jumped to the top. "
        for (label, length) in [("2 KB block", 2_000), ("8 KB block", 8_000)] {
            var source = ""
            while source.utf8.count < length { source += sentence }
            let characters = Array(source)
            for chunk in [12, 100] {
                var prefixes: [NSAttributedString] = []
                var end = 0
                while end < characters.count {
                    end = min(characters.count, end + chunk)
                    prefixes.append(NSAttributedString(string: String(characters[0 ..< end]), attributes: attributes))
                }
                func run(veil: Bool = false, paced: Bool = false, _ edit: (NSTextStorage, NSAttributedString) -> Void) -> Double {
                    let storage = NSTextStorage()
                    let layout = NSLayoutManager()
                    let container = NSTextContainer(size: CGSize(width: 704, height: CGFloat.greatestFiniteMagnitude))
                    container.lineFragmentPadding = 0
                    layout.addTextContainer(container)
                    storage.addLayoutManager(layout)
                    let clock = ContinuousClock()
                    let host = CALayer()
                    let elapsed = clock.measure {
                        for next in prefixes {
                            let start = storage.length
                            edit(storage, next)
                            layout.ensureLayout(for: container)
                            _ = layout.usedRect(for: container)
                            // The fade-in: one background-coloured layer per covered line, faded by Core Animation.
                            guard veil, next.length > start else { continue }
                            let added = NSRange(location: start, length: next.length - start)
                            let runs = paced ? segments(of: storage.string as NSString, in: added) : [added]
                            for (index, run) in runs.enumerated() {
                                let glyphs = layout.glyphRange(forCharacterRange: run, actualCharacterRange: nil)
                                layout.enumerateEnclosingRects(forGlyphRange: glyphs, withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0),
                                                               in: container) { rect, _ in
                                    let cover = CALayer()
                                    cover.frame = rect
                                    cover.backgroundColor = NSColor.white.cgColor
                                    let fade = CABasicAnimation(keyPath: "opacity")
                                    fade.fromValue = 1
                                    fade.toValue = 0
                                    fade.duration = 0.24
                                    fade.beginTime = CACurrentMediaTime() + 0.2 * Double(index) / Double(runs.count)
                                    fade.fillMode = .backwards
                                    cover.opacity = 0
                                    cover.add(fade, forKey: "fade")
                                    host.addSublayer(cover)
                                }
                            }
                            if (host.sublayers?.count ?? 0) > 64 { host.sublayers = nil }
                        }
                    }
                    return Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15
                }
                let replace = run { storage, next in storage.setAttributedString(next) }
                let tailEdit: (NSTextStorage, NSAttributedString) -> Void = { storage, next in
                    // Includes finding the first difference, as MessageSelectionTextView.replaceChangedTail does.
                    let start = firstDifference(storage, next)
                    storage.replaceCharacters(in: NSRange(location: start, length: storage.length - start),
                                              with: next.attributedSubstring(from: NSRange(location: start, length: next.length - start)))
                }
                let append = run(tailEdit)
                let faded = run(veil: true, tailEdit)
                let paced = run(veil: true, paced: true, tailEdit)
                print("\(label), \(chunk)-character deltas (\(prefixes.count) updates): replace + layout "
                      + String(format: "%.3f", replace / Double(prefixes.count)) + " ms/update, tail edit + layout "
                      + String(format: "%.3f", append / Double(prefixes.count)) + " ms/update, with fade-in veils "
                      + String(format: "%.3f", faded / Double(prefixes.count)) + " ms/update, paced by word run "
                      + String(format: "%.3f", paced / Double(prefixes.count)) + " ms/update")
            }
        }
    }

    /// A copy of StreamPacing.segments, which lives in the app target.
    static func segments(of string: NSString, in range: NSRange) -> [NSRange] {
        guard range.length > 0 else { return [] }
        var starts: [Int] = []
        string.enumerateSubstrings(in: range, options: [.byWords, .substringNotRequired]) { _, word, _, _ in
            if word.location > range.location { starts.append(word.location) }
        }
        let wanted = min(16, max(1, range.length / 8), starts.count + 1)
        var cuts: [Int] = []
        if wanted > 1 {
            // Evenly spaced cuts by position, each moved to the next word start that is not taken yet.
            var next = 0
            for index in 1 ..< wanted {
                let target = range.location + range.length * index / wanted
                while next < starts.count, starts[next] < target || (cuts.last.map { starts[next] <= $0 } ?? false) {
                    next += 1
                }
                guard next < starts.count else { break }
                cuts.append(starts[next])
                next += 1
            }
        }
        var segments: [NSRange] = []
        var start = range.location
        for cut in cuts + [NSMaxRange(range)] where cut > start {
            segments.append(NSRange(location: start, length: cut - start))
            start = cut
        }
        return segments
    }

    /// A copy of MessageSelectionTextView.firstDifference, which lives in the app target.
    static func firstDifference(_ old: NSAttributedString, _ new: NSAttributedString) -> Int {
        let common = (old.string as NSString).commonPrefix(with: new.string, options: .literal) as NSString
        var limit = common.length
        if limit > 0, limit < (new.string as NSString).length {
            limit = (new.string as NSString).rangeOfComposedCharacterSequence(at: limit).location
        }
        var index = 0
        while index < limit {
            var oldRun = NSRange(), newRun = NSRange()
            let range = NSRange(location: 0, length: limit)
            let oldAttributes = old.attributes(at: index, longestEffectiveRange: &oldRun, in: range)
            let newAttributes = new.attributes(at: index, longestEffectiveRange: &newRun, in: range)
            guard (oldAttributes as NSDictionary).isEqual(to: newAttributes) else { return index }
            if NSMaxRange(oldRun) != NSMaxRange(newRun) { return min(NSMaxRange(oldRun), NSMaxRange(newRun)) }
            index = NSMaxRange(oldRun)
        }
        return limit
    }
}
