import Foundation

public enum DiffLineKind: Equatable, Sendable {
    case context
    case addition
    case deletion
    case hunk
    case note
}

public struct DiffLine: Equatable, Sendable {
    public let kind: DiffLineKind
    public let text: String
    public let oldNumber: Int?
    public let newNumber: Int?
}

public struct FileDiff: Identifiable, Equatable, Sendable {
    public var id: String { path }
    public var path: String
    public var lines: [DiffLine]

    public var additions: Int { lines.filter { $0.kind == .addition }.count }
    public var deletions: Int { lines.filter { $0.kind == .deletion }.count }
}

public enum Diff {
    /// Git's unified diff (`git diff`), split per file.
    public static func parseUnified(_ text: String) -> [FileDiff] {
        var files: [FileDiff] = []
        var oldLine = 0
        var newLine = 0
        for line in text.components(separatedBy: "\n") {
            if line.hasPrefix("diff --git ") {
                // "diff --git a/x b/y": the b side, refined by "+++ b/…" below.
                let path = line.components(separatedBy: " b/").last ?? line
                files.append(FileDiff(path: path, lines: []))
                continue
            }
            guard !files.isEmpty else { continue }
            if line.hasPrefix("+++ ") {
                let target = String(line.dropFirst(4))
                if target != "/dev/null" { files[files.count - 1].path = target.hasPrefix("b/") ? String(target.dropFirst(2)) : target }
            } else if line.hasPrefix("--- ") || line.hasPrefix("index ") || line.hasPrefix("new file") || line.hasPrefix("deleted file")
                || line.hasPrefix("similarity") || line.hasPrefix("rename ") || line.hasPrefix("old mode") || line.hasPrefix("new mode")
            {
                continue
            } else if line.hasPrefix("@@") {
                (oldLine, newLine) = hunkStart(line)
                files[files.count - 1].lines.append(DiffLine(kind: .hunk, text: line, oldNumber: nil, newNumber: nil))
            } else if line.hasPrefix("+") {
                files[files.count - 1].lines.append(DiffLine(kind: .addition, text: String(line.dropFirst()), oldNumber: nil, newNumber: newLine))
                newLine += 1
            } else if line.hasPrefix("-") {
                files[files.count - 1].lines.append(DiffLine(kind: .deletion, text: String(line.dropFirst()), oldNumber: oldLine, newNumber: nil))
                oldLine += 1
            } else if line.hasPrefix(" ") {
                files[files.count - 1].lines.append(DiffLine(kind: .context, text: String(line.dropFirst()), oldNumber: oldLine, newNumber: newLine))
                oldLine += 1
                newLine += 1
            } else if line.hasPrefix("\\") {
                files[files.count - 1].lines.append(DiffLine(kind: .note, text: line, oldNumber: nil, newNumber: nil))
            }
        }
        return files
    }

    /// Codex V4A patches (`applyPatch`): "*** Update File: path", "@@" anchors, and +/-/space lines.
    public static func parsePatch(_ text: String) -> [FileDiff] {
        var files: [FileDiff] = []
        for line in text.components(separatedBy: "\n") {
            for marker in ["*** Update File: ", "*** Add File: ", "*** Delete File: "] where line.hasPrefix(marker) {
                files.append(FileDiff(path: String(line.dropFirst(marker.count)), lines: []))
            }
            guard !files.isEmpty, !line.hasPrefix("*** ") else { continue }
            let kind: DiffLineKind
            if line.hasPrefix("@@") { kind = .hunk }
            else if line.hasPrefix("+") { kind = .addition }
            else if line.hasPrefix("-") { kind = .deletion }
            else if line.hasPrefix(" ") { kind = .context }
            else { continue }
            let body = kind == .hunk ? line : String(line.dropFirst())
            files[files.count - 1].lines.append(DiffLine(kind: kind, text: body, oldNumber: nil, newNumber: nil))
        }
        return files
    }

    /// A replacement edit (old text to new text), as a minimal line diff.
    public static func parseEdit(path: String, old: String, new: String) -> FileDiff {
        let a = old.components(separatedBy: "\n")
        let b = new.components(separatedBy: "\n")
        guard a.count * b.count <= 250_000 else {
            return FileDiff(path: path, lines: a.map { DiffLine(kind: .deletion, text: $0, oldNumber: nil, newNumber: nil) }
                + b.map { DiffLine(kind: .addition, text: $0, oldNumber: nil, newNumber: nil) })
        }
        // Longest common subsequence, then walk it.
        var table = Array(repeating: Array(repeating: 0, count: b.count + 1), count: a.count + 1)
        for i in stride(from: a.count - 1, through: 0, by: -1) {
            for j in stride(from: b.count - 1, through: 0, by: -1) {
                table[i][j] = a[i] == b[j] ? table[i + 1][j + 1] + 1 : max(table[i + 1][j], table[i][j + 1])
            }
        }
        var lines: [DiffLine] = []
        var i = 0, j = 0
        while i < a.count || j < b.count {
            if i < a.count, j < b.count, a[i] == b[j] {
                lines.append(DiffLine(kind: .context, text: a[i], oldNumber: nil, newNumber: nil))
                i += 1
                j += 1
            } else if i < a.count, j == b.count || table[i + 1][j] >= table[i][j + 1] {
                // Deletions before additions, as in unified diffs.
                lines.append(DiffLine(kind: .deletion, text: a[i], oldNumber: nil, newNumber: nil))
                i += 1
            } else {
                lines.append(DiffLine(kind: .addition, text: b[j], oldNumber: nil, newNumber: nil))
                j += 1
            }
        }
        return FileDiff(path: path, lines: lines)
    }

    private static func hunkStart(_ header: String) -> (Int, Int) {
        // "@@ -12,7 +12,8 @@ context"
        let parts = header.split(separator: " ")
        func start(_ prefix: Character) -> Int {
            guard let part = parts.first(where: { $0.first == prefix }) else { return 0 }
            return Int(part.dropFirst().split(separator: ",").first ?? "") ?? 0
        }
        return (start("-"), start("+"))
    }
}
