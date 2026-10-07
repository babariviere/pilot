import Foundation

/// Filesystem completion for a path token in a message. Ranges use AppKit's UTF-16 offsets.
public enum PathCompletion {
    public static func range(in text: String, selection: NSRange) -> NSRange? {
        let source = text as NSString
        guard selection.length == 0, selection.location <= source.length else { return nil }
        var start = 0
        var quote: unichar?
        var escaped = false
        for index in 0..<selection.location {
            let character = source.character(at: index)
            if escaped { escaped = false; continue }
            if character == 92 { escaped = true; continue }
            if let delimiter = quote {
                if character == delimiter { quote = nil; start = index + 1 }
            } else if (character == 34 || character == 39 || character == 96), index == start {
                quote = character
                start = index + 1
            } else if UnicodeScalar(character).map({ CharacterSet.whitespacesAndNewlines.contains($0) }) ?? false {
                start = index + 1
            }
        }
        guard start < selection.location else { return nil }
        if selection.location < source.length {
            let next = source.character(at: selection.location)
            let boundary = quote.map { next == $0 }
                ?? (UnicodeScalar(next).map { CharacterSet.whitespacesAndNewlines.contains($0) } ?? false)
            // Completing just the prefix inside a token would duplicate its existing suffix.
            guard boundary else { return nil }
        }
        return NSRange(location: start, length: selection.location - start)
    }

    public static func candidates(in text: String, range: NSRange, directory: String) -> [String] {
        let source = text as NSString
        guard range.location <= source.length, range.length <= source.length - range.location else { return [] }
        let token = source.substring(with: range)
        guard !token.isEmpty else { return [] }
        let quoted = range.location > 0 && [34, 39, 96].contains(Int(source.character(at: range.location - 1)))
        let path = unescape(token)
        if path == "~" { return ["~/"] }
        // Do not mistake links for local paths.
        guard !path.contains("://") else { return [] }
        let slash = path.lastIndex(of: "/")
        let parent = slash.map { String(path[...$0]) } ?? ""
        let prefix = slash.map { String(path[path.index(after: $0)...]) } ?? path
        let expanded = (parent as NSString).expandingTildeInPath
        let base = URL(fileURLWithPath: (directory as NSString).expandingTildeInPath, isDirectory: true)
        let folder = expanded.hasPrefix("/")
            ? URL(fileURLWithPath: expanded, isDirectory: true)
            : base.appendingPathComponent(expanded, isDirectory: true)
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: folder.path) else { return [] }
        return names.sorted().compactMap { name in
            guard name.hasPrefix(prefix), !name.hasPrefix(".") || prefix.hasPrefix(".") else { return nil }
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: folder.appendingPathComponent(name).path, isDirectory: &isDirectory) else { return nil }
            let candidate = parent + name + (isDirectory.boolValue ? "/" : "")
            if quoted {
                let delimiter = source.character(at: range.location - 1)
                // A name containing the quote delimiter cannot be inserted safely into this token.
                guard !candidate.utf16.contains(delimiter) else { return nil }
                return candidate.replacingOccurrences(of: "\\", with: "\\\\")
            }
            return candidate.reduce(into: "") { result, character in
                if character.isWhitespace || "\\\"'`".contains(character) { result.append("\\") }
                result.append(character)
            }
        }
    }

    private static func unescape(_ text: String) -> String {
        var result = ""
        var escaped = false
        for character in text {
            if escaped { result.append(character); escaped = false }
            else if character == "\\" { escaped = true }
            else { result.append(character) }
        }
        if escaped { result.append("\\") }
        return result
    }
}
