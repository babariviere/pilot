import Foundation

public enum ToolStatus: String, Equatable, Sendable {
    case pending
    case running
    case done
    case error
}

public struct ToolItem: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let arguments: JSONValue
    public let status: ToolStatus
    public let output: String

    public var summary: ToolSummary { ToolSummary(name: name, arguments: arguments) }
}

/// One visual row of the chat. Consecutive tool calls are grouped.
public enum ChatRow: Identifiable, Equatable, Sendable {
    case user(id: String, text: String)
    case text(id: String, text: String)
    case thinking(id: String, text: String, streaming: Bool)
    case tools(id: String, items: [ToolItem])
    case error(id: String, text: String)
    case notice(id: String, text: String)

    public var id: String {
        switch self {
        case let .user(id, _), let .text(id, _), let .thinking(id, _, _), let .tools(id, _), let .error(id, _),
             let .notice(id, _):
            id
        }
    }
}

extension Transcript {
    public var rows: [ChatRow] {
        let results = results
        var rows: [ChatRow] = []

        func append(_ row: ChatRow) {
            // Merge adjacent tool groups, also across assistant messages.
            if case let .tools(_, items) = row, case let .tools(id, previous)? = rows.last {
                rows[rows.count - 1] = .tools(id: id, items: previous + items)
            } else {
                rows.append(row)
            }
        }

        func appendAssistant(_ message: ChatMessage, id: String, streaming: Bool) {
            for (index, block) in message.blocks.enumerated() {
                let blockId = "\(id)-\(index)"
                let isLast = index == message.blocks.count - 1
                switch block {
                case let .text(text) where !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
                    append(.text(id: blockId, text: text))
                case let .thinking(text) where !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
                    append(.thinking(id: blockId, text: text, streaming: streaming && isLast))
                case let .toolCall(callId, name, arguments):
                    append(.tools(id: blockId, items: [tool(callId, name: name, arguments: arguments, results: results)]))
                default:
                    break
                }
            }
            if message.stopReason == "error", let error = message.errorMessage {
                append(.error(id: "\(id)-error", text: error))
            } else if message.stopReason == "aborted" {
                append(.notice(id: "\(id)-aborted", text: "Stopped"))
            }
        }

        for entry in entries {
            switch entry.kind {
            case "pi.compaction": append(.notice(id: "\(entry.id)", text: "Context compacted"))
            case "pi.reset": append(.notice(id: "\(entry.id)", text: "Context reset"))
            default:
                for (index, message) in entry.messages.enumerated() {
                    let id = "\(entry.id)-\(index)"
                    switch message.role {
                    case "user": append(.user(id: id, text: message.text))
                    case "assistant": appendAssistant(message, id: id, streaming: false)
                    default: break
                    }
                }
            }
        }
        if let streaming { appendAssistant(streaming, id: "streaming", streaming: true) }
        if let error { append(.error(id: "transcript-error", text: error)) }
        return rows
    }

    private func tool(_ callId: String, name: String, arguments: JSONValue, results: [String: ChatMessage]) -> ToolItem {
        if let result = results[callId] {
            return ToolItem(id: callId, name: name, arguments: arguments, status: result.isError ? .error : .done, output: result.text)
        }
        let live = tools[callId]
        let status: ToolStatus = switch live?.status {
        case "running": .running
        case "done": .done
        default: .pending
        }
        return ToolItem(id: callId, name: name, arguments: arguments, status: status, output: live?.output ?? "")
    }
}

/// A short, human description of a tool call.
public struct ToolSummary: Equatable, Sendable {
    public let icon: String
    public let title: String
    public let detail: String?
    /// The most useful argument to show expanded (a command, script or patch), else nil for JSON.
    public let body: String?
    /// Line diffs for edits (applyPatch, edit, write), for stats and colored rendering.
    public let diffs: [FileDiff]

    public var additions: Int { diffs.reduce(0) { $0 + $1.additions } }
    public var deletions: Int { diffs.reduce(0) { $0 + $1.deletions } }

    public init(name: String, arguments: JSONValue) {
        let string = { (key: String) in arguments[key]?.string }
        var diffs: [FileDiff] = []
        switch name {
        case "bash":
            icon = "terminal"
            title = "Ran command"
            detail = string("command").map(Self.firstLine)
            body = string("command")
        case "codemode":
            let code = string("code") ?? ""
            icon = "curlybraces"
            if let command = Self.match(code, #"tools\.bash\(\{\s*command:\s*"((?:[^"\\]|\\.)*)""#) {
                title = "Ran command"
                detail = Self.firstLine(command.replacingOccurrences(of: "\\\"", with: "\""))
            } else if let path = Self.match(code, #"tools\.read\(\{\s*path:\s*"([^"]*)""#) {
                title = "Read file"
                detail = path
            } else if Self.match(code, #"(tools\.applyPatch)"#) != nil {
                title = "Edited files"
                detail = Self.patchedFiles(code)
            } else {
                title = "Ran script"
                detail = Self.firstLine(code)
            }
            body = code
        case "read":
            icon = "doc.text"
            title = "Read file"
            detail = string("path")
            body = nil
        case "edit", "write":
            icon = "pencil"
            title = name == "edit" ? "Edited file" : "Wrote file"
            detail = string("path")
            body = string("content") ?? string("newText")
            let path = string("path") ?? "file"
            if name == "write", let content = string("content") {
                diffs = [Diff.parseEdit(path: path, old: "", new: content)]
            } else if let old = string("oldText"), let new = string("newText") {
                diffs = [Diff.parseEdit(path: path, old: old, new: new)]
            } else if let edits = arguments["edits"]?.array {
                diffs = edits.compactMap { edit in
                    guard let old = edit["oldText"]?.string, let new = edit["newText"]?.string else { return nil }
                    return Diff.parseEdit(path: path, old: old, new: new)
                }
            }
        case "applyPatch":
            icon = "pencil"
            title = "Edited files"
            detail = string("patch").flatMap(Self.patchedFiles)
            body = string("patch")
            diffs = string("patch").map(Diff.parsePatch) ?? []
        case "web_search":
            icon = "magnifyingglass"
            title = "Searched the web"
            detail = string("query")
            body = nil
        case "fetch_content":
            icon = "globe"
            title = "Fetched page"
            detail = string("url")
            body = nil
        case "subagent":
            icon = "person.2"
            title = "Subagent \(string("action") ?? "")".trimmingCharacters(in: .whitespaces)
            detail = string("name")
            body = string("message")
        default:
            icon = name.hasPrefix("mcp__") ? "puzzlepiece.extension" : "wrench.and.screwdriver"
            title = name.replacingOccurrences(of: "_", with: " ")
            detail = Self.firstStringArgument(arguments).map(Self.firstLine)
            body = nil
        }
        self.diffs = diffs
    }

    private static func firstLine(_ text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        return line.map { String($0).trimmingCharacters(in: .whitespaces) } ?? ""
    }

    private static func match(_ text: String, _ pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let found = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let range = Range(found.range(at: 1), in: text)
        else { return nil }
        return String(text[range])
    }

    private static func patchedFiles(_ patch: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: #"\*\*\* (?:Update|Add|Delete) File: ([^\n"\\]+)"#) else { return nil }
        let names = regex.matches(in: patch, range: NSRange(patch.startIndex..., in: patch)).compactMap {
            Range($0.range(at: 1), in: patch).map { URL(filePath: String(patch[$0])).lastPathComponent }
        }
        return names.isEmpty ? nil : names.joined(separator: ", ")
    }

    private static func firstStringArgument(_ arguments: JSONValue) -> String? {
        guard case let .object(object) = arguments else { return nil }
        return object.keys.sorted().lazy.compactMap { object[$0]?.string }.first
    }
}
