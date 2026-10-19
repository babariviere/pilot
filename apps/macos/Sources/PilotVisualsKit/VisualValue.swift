import Foundation

/// A JSON value from a visual: the runtime's node tree and anything inside it. Objects keep their key order.
public enum VisualValue: Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([VisualValue])
    case object(VisualObject)

    public subscript(key: String) -> VisualValue? {
        if case .object(let object) = self { return object[key] }
        return nil
    }

    public var stringValue: String? {
        if case .string(let text) = self { return text }
        return nil
    }

    public var numberValue: Double? {
        if case .number(let number) = self { return number }
        return nil
    }

    public var boolValue: Bool? {
        if case .bool(let flag) = self { return flag }
        return nil
    }

    public var arrayValue: [VisualValue]? {
        if case .array(let items) = self { return items }
        return nil
    }

    public var objectValue: VisualObject? {
        if case .object(let object) = self { return object }
        return nil
    }
}

/// An ordered JSON object. Visual nodes have a handful of keys, so lookups scan.
public struct VisualObject: Hashable, Sendable {
    public struct Entry: Hashable, Sendable {
        public var key: String
        public var value: VisualValue

        public init(_ key: String, _ value: VisualValue) {
            self.key = key
            self.value = value
        }
    }

    public var entries: [Entry]

    public init(_ entries: [Entry] = []) {
        self.entries = entries
    }

    public var keys: [String] { entries.map(\.key) }

    public subscript(key: String) -> VisualValue? {
        entries.last { $0.key == key }?.value
    }
}

extension VisualValue: ExpressibleByNilLiteral, ExpressibleByBooleanLiteral, ExpressibleByFloatLiteral,
    ExpressibleByIntegerLiteral, ExpressibleByStringLiteral, ExpressibleByArrayLiteral,
    ExpressibleByDictionaryLiteral {
    public init(nilLiteral: ()) { self = .null }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(stringLiteral value: String) { self = .string(value) }
    public init(arrayLiteral elements: VisualValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, VisualValue)...) {
        self = .object(VisualObject(elements.map { VisualObject.Entry($0.0, $0.1) }))
    }
}

// MARK: - JSON

extension VisualValue {
    /// JSON text in the form JSON.parse accepts. Non-finite numbers become null, as in JSON.stringify.
    public var jsonData: Data {
        var output = ""
        Self.write(self, to: &output)
        return Data(output.utf8)
    }

    /// Parses JSON with Foundation. Numbers become doubles; object keys are sorted because Foundation drops
    /// their order.
    public init(json: Data) throws {
        let object = try JSONSerialization.jsonObject(with: json, options: [.fragmentsAllowed])
        self = try Self.from(foundation: object, depth: 0)
    }

    private static func from(foundation object: Any, depth: Int) throws -> VisualValue {
        guard depth <= VisualWire.maxDepth else { throw VisualWireError.tooDeep }
        switch object {
        case is NSNull:
            return .null
        case let number as NSNumber:
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return .bool(number.boolValue) }
            return .number(number.doubleValue)
        case let text as String:
            return .string(text)
        case let items as [Any]:
            return .array(try items.map { try from(foundation: $0, depth: depth + 1) })
        case let dictionary as [String: Any]:
            return .object(VisualObject(try dictionary.keys.sorted().map {
                VisualObject.Entry($0, try from(foundation: dictionary[$0] as Any, depth: depth + 1))
            }))
        default:
            throw VisualWireError.malformed
        }
    }

    private static func write(_ value: VisualValue, to output: inout String) {
        switch value {
        case .null:
            output += "null"
        case .bool(let flag):
            output += flag ? "true" : "false"
        case .number(let number):
            output += formatNumber(number)
        case .string(let text):
            writeString(text, to: &output)
        case .array(let items):
            output += "["
            for (index, item) in items.enumerated() {
                if index > 0 { output += "," }
                write(item, to: &output)
            }
            output += "]"
        case .object(let object):
            output += "{"
            for (index, entry) in object.entries.enumerated() {
                if index > 0 { output += "," }
                writeString(entry.key, to: &output)
                output += ":"
                write(entry.value, to: &output)
            }
            output += "}"
        }
    }

    static func formatNumber(_ number: Double) -> String {
        guard number.isFinite else { return "null" }
        if number == number.rounded(), abs(number) < 1e15 { return String(Int64(number)) }
        return "\(number)"
    }

    private static func writeString(_ text: String, to output: inout String) {
        output += "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": output += "\\\""
            case "\\": output += "\\\\"
            case "\n": output += "\\n"
            case "\r": output += "\\r"
            case "\t": output += "\\t"
            default:
                if scalar.value < 0x20 {
                    output += String(format: "\\u%04x", scalar.value)
                } else {
                    output.unicodeScalars.append(scalar)
                }
            }
        }
        output += "\""
    }
}

