import Foundation
import CoreFoundation

/// Untyped JSON, for pi-durable agent events whose shapes are wide and evolving.
public enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: any Decoder) throws {
        if let decoder = decoder as? JSONValueDecoder {
            self = decoder.value
            return
        }
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case let .bool(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .string(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        }
    }

    public subscript(key: String) -> JSONValue? {
        if case let .object(object) = self { return object[key] }
        return nil
    }

    public var string: String? { if case let .string(value) = self { value } else { nil } }
    public var number: Double? { if case let .number(value) = self { value } else { nil } }
    public var int: Int? { number.flatMap { Int(exactly: $0.rounded(.towardZero)) } }
    public var bool: Bool? { if case let .bool(value) = self { value } else { nil } }
    public var array: [JSONValue]? { if case let .array(value) = self { value } else { nil } }
    public var isNull: Bool { self == .null }

    public static func decode(_ data: Data) throws -> JSONValue {
        // Foundation identifies node types without throwing a decoding error for each
        // unsuccessful Bool/Double/String/Array probe at every level of the tree.
        try fromFoundation(JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]))
    }

    private static func fromFoundation(_ value: Any) throws -> JSONValue {
        switch value {
        case is NSNull: return .null
        case let value as NSNumber:
            // NSNumber bridges both JSON booleans and numbers. A numeric 0 or 1 is
            // not a Bool, even though Swift's conditional Bool cast can accept it.
            if CFGetTypeID(value) == CFBooleanGetTypeID() { return .bool(value.boolValue) }
            guard value.doubleValue.isFinite else {
                throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "Non-finite JSON number"))
            }
            return .number(value.doubleValue)
        case let value as String: return .string(value)
        case let value as [Any]: return .array(try value.map(fromFoundation))
        case let value as [String: Any]: return .object(try value.mapValues(fromFoundation))
        default:
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "Unsupported JSON value"))
        }
    }

    /// Decodes a typed value out of this JSON.
    public func decode<T: Decodable>(_: T.Type) throws -> T {
        try JSONValueDecoder(value: self).decode(T.self)
    }

    public var prettyPrinted: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(self) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }
}
