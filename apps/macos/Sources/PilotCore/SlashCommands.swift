import Foundation

/// One entry in the composer's slash command menu.
public struct SlashCommand: Equatable, Sendable, Identifiable {
    public enum Kind: Equatable, Sendable {
        /// Handled by the app, never sent as a message.
        case builtin
        case prompt
        case skill
    }

    public let name: String
    public let kind: Kind
    public let description: String?
    public let argumentHint: String?
    public var id: String { name }
    public var invocation: String { "/" + name }

    public init(name: String, kind: Kind, description: String? = nil, argumentHint: String? = nil) {
        self.name = name
        self.kind = kind
        self.description = description
        self.argumentHint = argumentHint
    }

    public init(_ command: SessionCommand) {
        self.init(name: command.name, kind: command.source == .skill ? .skill : .prompt,
                  description: command.description, argumentHint: command.argumentHint)
    }
}

/// Slash command completion and the app's built-in commands. Ranges use AppKit's UTF-16 offsets.
public enum SlashCommands {
    public static let compact = SlashCommand(
        name: "compact", kind: .builtin,
        description: "Summarize older messages to free up context", argumentHint: "[instructions]"
    )
    public static let builtins = [compact]

    /// Built-ins first, then the session's prompt templates and skills. Session commands cannot shadow built-ins.
    public static func all(_ session: [SessionCommand]) -> [SlashCommand] {
        let reserved = Set(builtins.map(\.name))
        return builtins + session.filter { !reserved.contains($0.name) }.map(SlashCommand.init)
    }

    /// The command token being typed: a leading "/" through the caret, before any whitespace.
    public static func range(in text: String, selection: NSRange) -> NSRange? {
        let source = text as NSString
        guard selection.length == 0, selection.location > 0, selection.location <= source.length,
              source.character(at: 0) == 47 else { return nil }
        for index in 1..<selection.location {
            let character = source.character(at: index)
            if UnicodeScalar(character).map({ CharacterSet.whitespacesAndNewlines.contains($0) }) ?? true { return nil }
        }
        // Completing inside a token would duplicate its existing suffix.
        if selection.location < source.length,
           !(UnicodeScalar(source.character(at: selection.location)).map { CharacterSet.whitespacesAndNewlines.contains($0) } ?? false) {
            return nil
        }
        return NSRange(location: 0, length: selection.location)
    }

    /// Prefix matches first (of the full name, or of a skill's name after "skill:"), then substring matches,
    /// each keeping the given order. An empty query lists everything.
    public static func matches(_ query: String, in commands: [SlashCommand], limit: Int = 50) -> [SlashCommand] {
        let query = query.lowercased()
        guard !query.isEmpty else { return Array(commands.prefix(limit)) }
        var prefixed: [SlashCommand] = []
        var contained: [SlashCommand] = []
        for command in commands {
            let name = command.name.lowercased()
            let bare = command.kind == .skill && name.hasPrefix("skill:") ? String(name.dropFirst(6)) : name
            if name.hasPrefix(query) || bare.hasPrefix(query) { prefixed.append(command) }
            else if name.contains(query) { contained.append(command) }
        }
        return Array((prefixed + contained).prefix(limit))
    }

    /// Instructions for a `/compact [instructions]` message, empty when none; nil for any other message.
    public static func compactInstructions(_ message: String) -> String? {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        let invocation = compact.invocation
        guard text.hasPrefix(invocation) else { return nil }
        let rest = text.dropFirst(invocation.count)
        guard rest.isEmpty || rest.first!.isWhitespace else { return nil }
        return rest.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

