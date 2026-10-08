import Foundation

/// Decodes an already parsed JSON tree using JSONDecoder's default strategies,
/// without encoding it to bytes and parsing it a second time.
struct JSONValueDecoder: Decoder {
    let value: JSONValue
    var codingPath: [any CodingKey] = []
    var userInfo: [CodingUserInfoKey: Any] { [:] }

    func child(_ value: JSONValue, key: any CodingKey) -> JSONValueDecoder {
        JSONValueDecoder(value: value, codingPath: codingPath + [key])
    }

    func mismatch(_ type: Any.Type) -> DecodingError {
        if value.isNull {
            return .valueNotFound(type, .init(codingPath: codingPath, debugDescription: "Unexpected null"))
        }
        return .typeMismatch(type, .init(codingPath: codingPath, debugDescription: "JSON value has the wrong type"))
    }

    func decode<T: Decodable>(_ type: T.Type) throws -> T {
        if type == JSONValue.self { return value as! T }
        if type == Bool.self {
            guard case let .bool(bool) = value else { throw mismatch(type) }
            return bool as! T
        }
        if type == String.self {
            guard case let .string(string) = value else { throw mismatch(type) }
            return string as! T
        }
        if type == Data.self {
            guard case let .string(string) = value else { throw mismatch(type) }
            guard let data = Data(base64Encoded: string) else {
                throw DecodingError.dataCorrupted(.init(codingPath: codingPath, debugDescription: "Invalid base64 data"))
            }
            return data as! T
        }
        // Foundation's JSONDecoder special-cases these types rather than invoking
        // their general-purpose Codable representations (URL otherwise asks for keys).
        if type == URL.self {
            guard case let .string(string) = value else { throw mismatch(type) }
            guard let url = URL(string: string) else {
                throw DecodingError.dataCorrupted(.init(codingPath: codingPath, debugDescription: "Invalid URL"))
            }
            return url as! T
        }
        if type == Decimal.self {
            guard case let .number(number) = value else { throw mismatch(type) }
            guard number.isFinite,
                  let decimal = Decimal(string: String(number), locale: Locale(identifier: "en_US_POSIX")) else {
                throw DecodingError.dataCorrupted(.init(codingPath: codingPath, debugDescription: "Invalid decimal"))
            }
            return decimal as! T
        }
        if type == Double.self {
            guard case let .number(number) = value else { throw mismatch(type) }
            guard number.isFinite else { throw mismatch(type) }
            return number as! T
        }
        if type == Float.self {
            guard case let .number(number) = value else { throw mismatch(type) }
            let converted = Float(number)
            guard converted.isFinite else { throw mismatch(type) }
            return converted as! T
        }
        if type == Int.self {
            guard case let .number(number) = value else { throw mismatch(type) }
            guard let converted = Int(exactly: number) else {
                throw DecodingError.dataCorrupted(.init(codingPath: codingPath, debugDescription: "Number does not fit Int"))
            }
            return converted as! T
        }
        if type == Int8.self {
            guard case let .number(number) = value else { throw mismatch(type) }
            guard let converted = Int8(exactly: number) else {
                throw DecodingError.dataCorrupted(.init(codingPath: codingPath, debugDescription: "Number does not fit Int8"))
            }
            return converted as! T
        }
        if type == Int16.self {
            guard case let .number(number) = value else { throw mismatch(type) }
            guard let converted = Int16(exactly: number) else {
                throw DecodingError.dataCorrupted(.init(codingPath: codingPath, debugDescription: "Number does not fit Int16"))
            }
            return converted as! T
        }
        if type == Int32.self {
            guard case let .number(number) = value else { throw mismatch(type) }
            guard let converted = Int32(exactly: number) else {
                throw DecodingError.dataCorrupted(.init(codingPath: codingPath, debugDescription: "Number does not fit Int32"))
            }
            return converted as! T
        }
        if type == Int64.self {
            guard case let .number(number) = value else { throw mismatch(type) }
            guard let converted = Int64(exactly: number) else {
                throw DecodingError.dataCorrupted(.init(codingPath: codingPath, debugDescription: "Number does not fit Int64"))
            }
            return converted as! T
        }
        if type == UInt.self {
            guard case let .number(number) = value else { throw mismatch(type) }
            guard let converted = UInt(exactly: number) else {
                throw DecodingError.dataCorrupted(.init(codingPath: codingPath, debugDescription: "Number does not fit UInt"))
            }
            return converted as! T
        }
        if type == UInt8.self {
            guard case let .number(number) = value else { throw mismatch(type) }
            guard let converted = UInt8(exactly: number) else {
                throw DecodingError.dataCorrupted(.init(codingPath: codingPath, debugDescription: "Number does not fit UInt8"))
            }
            return converted as! T
        }
        if type == UInt16.self {
            guard case let .number(number) = value else { throw mismatch(type) }
            guard let converted = UInt16(exactly: number) else {
                throw DecodingError.dataCorrupted(.init(codingPath: codingPath, debugDescription: "Number does not fit UInt16"))
            }
            return converted as! T
        }
        if type == UInt32.self {
            guard case let .number(number) = value else { throw mismatch(type) }
            guard let converted = UInt32(exactly: number) else {
                throw DecodingError.dataCorrupted(.init(codingPath: codingPath, debugDescription: "Number does not fit UInt32"))
            }
            return converted as! T
        }
        if type == UInt64.self {
            guard case let .number(number) = value else { throw mismatch(type) }
            guard let converted = UInt64(exactly: number) else {
                throw DecodingError.dataCorrupted(.init(codingPath: codingPath, debugDescription: "Number does not fit UInt64"))
            }
            return converted as! T
        }
        return try T(from: self)
    }

    func container<Key: CodingKey>(keyedBy type: Key.Type) throws -> KeyedDecodingContainer<Key> {
        guard case let .object(object) = value else { throw mismatch([String: JSONValue].self) }
        return KeyedDecodingContainer(JSONObjectContainer<Key>(decoder: self, object: object))
    }

    func unkeyedContainer() throws -> any UnkeyedDecodingContainer {
        guard case let .array(array) = value else { throw mismatch([JSONValue].self) }
        return JSONArrayContainer(decoder: self, array: array)
    }

    func singleValueContainer() throws -> any SingleValueDecodingContainer {
        JSONSingleContainer(decoder: self)
    }
}

private struct JSONKey: CodingKey {
    let stringValue: String
    let intValue: Int?
    init(stringValue: String) { self.stringValue = stringValue; intValue = nil }
    init(intValue: Int) { self.intValue = intValue; stringValue = "Index \(intValue)" }
}

private struct JSONSingleContainer: SingleValueDecodingContainer {
    let decoder: JSONValueDecoder
    var codingPath: [any CodingKey] { decoder.codingPath }
    func decodeNil() -> Bool { decoder.value.isNull }
    func decode<T: Decodable>(_ type: T.Type) throws -> T { try decoder.decode(type) }
    func decode(_ type: Bool.Type) throws -> Bool { try decoder.decode(type) }
    func decode(_ type: String.Type) throws -> String { try decoder.decode(type) }
    func decode(_ type: Double.Type) throws -> Double { try decoder.decode(type) }
    func decode(_ type: Float.Type) throws -> Float { try decoder.decode(type) }
    func decode(_ type: Int.Type) throws -> Int { try decoder.decode(type) }
    func decode(_ type: Int8.Type) throws -> Int8 { try decoder.decode(type) }
    func decode(_ type: Int16.Type) throws -> Int16 { try decoder.decode(type) }
    func decode(_ type: Int32.Type) throws -> Int32 { try decoder.decode(type) }
    func decode(_ type: Int64.Type) throws -> Int64 { try decoder.decode(type) }
    func decode(_ type: UInt.Type) throws -> UInt { try decoder.decode(type) }
    func decode(_ type: UInt8.Type) throws -> UInt8 { try decoder.decode(type) }
    func decode(_ type: UInt16.Type) throws -> UInt16 { try decoder.decode(type) }
    func decode(_ type: UInt32.Type) throws -> UInt32 { try decoder.decode(type) }
    func decode(_ type: UInt64.Type) throws -> UInt64 { try decoder.decode(type) }
}

private struct JSONObjectContainer<Key: CodingKey>: KeyedDecodingContainerProtocol {
    let decoder: JSONValueDecoder
    let object: [String: JSONValue]
    var codingPath: [any CodingKey] { decoder.codingPath }
    var allKeys: [Key] { object.keys.compactMap(Key.init(stringValue:)) }
    func contains(_ key: Key) -> Bool { object[key.stringValue] != nil }
    private func child(_ key: Key) throws -> JSONValueDecoder {
        guard let value = object[key.stringValue] else {
            throw DecodingError.keyNotFound(key, .init(codingPath: codingPath, debugDescription: "Missing key"))
        }
        return decoder.child(value, key: key)
    }
    func decodeNil(forKey key: Key) throws -> Bool { try child(key).value.isNull }
    func decode<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> T { try child(key).decode(type) }
    func decode(_ type: Bool.Type, forKey key: Key) throws -> Bool { try child(key).decode(type) }
    func decode(_ type: String.Type, forKey key: Key) throws -> String { try child(key).decode(type) }
    func decode(_ type: Double.Type, forKey key: Key) throws -> Double { try child(key).decode(type) }
    func decode(_ type: Float.Type, forKey key: Key) throws -> Float { try child(key).decode(type) }
    func decode(_ type: Int.Type, forKey key: Key) throws -> Int { try child(key).decode(type) }
    func decode(_ type: Int8.Type, forKey key: Key) throws -> Int8 { try child(key).decode(type) }
    func decode(_ type: Int16.Type, forKey key: Key) throws -> Int16 { try child(key).decode(type) }
    func decode(_ type: Int32.Type, forKey key: Key) throws -> Int32 { try child(key).decode(type) }
    func decode(_ type: Int64.Type, forKey key: Key) throws -> Int64 { try child(key).decode(type) }
    func decode(_ type: UInt.Type, forKey key: Key) throws -> UInt { try child(key).decode(type) }
    func decode(_ type: UInt8.Type, forKey key: Key) throws -> UInt8 { try child(key).decode(type) }
    func decode(_ type: UInt16.Type, forKey key: Key) throws -> UInt16 { try child(key).decode(type) }
    func decode(_ type: UInt32.Type, forKey key: Key) throws -> UInt32 { try child(key).decode(type) }
    func decode(_ type: UInt64.Type, forKey key: Key) throws -> UInt64 { try child(key).decode(type) }
    func nestedContainer<NestedKey: CodingKey>(keyedBy type: NestedKey.Type, forKey key: Key) throws -> KeyedDecodingContainer<NestedKey> {
        try child(key).container(keyedBy: type)
    }
    func nestedUnkeyedContainer(forKey key: Key) throws -> any UnkeyedDecodingContainer { try child(key).unkeyedContainer() }
    func superDecoder() throws -> any Decoder {
        decoder.child(object["super"] ?? .null, key: JSONKey(stringValue: "super"))
    }
    func superDecoder(forKey key: Key) throws -> any Decoder { try child(key) }
}

private struct JSONArrayContainer: UnkeyedDecodingContainer {
    let decoder: JSONValueDecoder
    let array: [JSONValue]
    var codingPath: [any CodingKey] { decoder.codingPath }
    var count: Int? { array.count }
    var currentIndex = 0
    var isAtEnd: Bool { currentIndex >= array.count }
    private func child() throws -> JSONValueDecoder {
        guard !isAtEnd else {
            throw DecodingError.valueNotFound(JSONValue.self, .init(
                codingPath: codingPath + [JSONKey(intValue: currentIndex)], debugDescription: "Array is at end"))
        }
        return decoder.child(array[currentIndex], key: JSONKey(intValue: currentIndex))
    }
    mutating func decodeNil() throws -> Bool {
        if try child().value.isNull { currentIndex += 1; return true }
        return false
    }
    mutating func decode<T: Decodable>(_ type: T.Type) throws -> T {
        let value = try child().decode(type)
        currentIndex += 1
        return value
    }
    mutating func decode(_ type: Bool.Type) throws -> Bool {
        let value = try child().decode(type)
        currentIndex += 1
        return value
    }
    mutating func decode(_ type: String.Type) throws -> String {
        let value = try child().decode(type)
        currentIndex += 1
        return value
    }
    mutating func decode(_ type: Double.Type) throws -> Double {
        let value = try child().decode(type)
        currentIndex += 1
        return value
    }
    mutating func decode(_ type: Float.Type) throws -> Float {
        let value = try child().decode(type)
        currentIndex += 1
        return value
    }
    mutating func decode(_ type: Int.Type) throws -> Int {
        let value = try child().decode(type)
        currentIndex += 1
        return value
    }
    mutating func decode(_ type: Int8.Type) throws -> Int8 {
        let value = try child().decode(type)
        currentIndex += 1
        return value
    }
    mutating func decode(_ type: Int16.Type) throws -> Int16 {
        let value = try child().decode(type)
        currentIndex += 1
        return value
    }
    mutating func decode(_ type: Int32.Type) throws -> Int32 {
        let value = try child().decode(type)
        currentIndex += 1
        return value
    }
    mutating func decode(_ type: Int64.Type) throws -> Int64 {
        let value = try child().decode(type)
        currentIndex += 1
        return value
    }
    mutating func decode(_ type: UInt.Type) throws -> UInt {
        let value = try child().decode(type)
        currentIndex += 1
        return value
    }
    mutating func decode(_ type: UInt8.Type) throws -> UInt8 {
        let value = try child().decode(type)
        currentIndex += 1
        return value
    }
    mutating func decode(_ type: UInt16.Type) throws -> UInt16 {
        let value = try child().decode(type)
        currentIndex += 1
        return value
    }
    mutating func decode(_ type: UInt32.Type) throws -> UInt32 {
        let value = try child().decode(type)
        currentIndex += 1
        return value
    }
    mutating func decode(_ type: UInt64.Type) throws -> UInt64 {
        let value = try child().decode(type)
        currentIndex += 1
        return value
    }
    mutating func nestedContainer<NestedKey: CodingKey>(keyedBy type: NestedKey.Type) throws -> KeyedDecodingContainer<NestedKey> {
        let container = try child().container(keyedBy: type)
        currentIndex += 1
        return container
    }
    mutating func nestedUnkeyedContainer() throws -> any UnkeyedDecodingContainer {
        let container = try child().unkeyedContainer()
        currentIndex += 1
        return container
    }
    mutating func superDecoder() throws -> any Decoder {
        let decoder = try child()
        currentIndex += 1
        return decoder
    }
}
