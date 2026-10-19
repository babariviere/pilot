import Foundation

public enum VisualWireError: Error, Equatable {
    case badHeader
    case truncated
    case malformed
    case tooDeep
}

/// The compact binary encoding visual results use across XPC. The C engine writes it
/// (Sources/PilotVisualEngine/pilot_visual_engine.c documents the format); this side reads it and, for tests and
/// service-side replies, writes it.
public enum VisualWire {
    static let magic: [UInt8] = [0x50, 0x56, 0x01]
    public static let maxDepth = 128
    static let internLimit = 4096
    static let internMaxLength = 64

    enum Tag: UInt8 {
        case null = 0, falseValue, trueValue, integer, float, string, array, object
    }

    // MARK: Decoding

    public static func decode(_ data: Data) throws -> VisualValue {
        try data.withUnsafeBytes { raw -> VisualValue in
            var reader = Reader(bytes: raw.bindMemory(to: UInt8.self))
            for byte in magic where try reader.byte() != byte { throw VisualWireError.badHeader }
            let value = try reader.value(depth: 0)
            guard reader.offset == reader.bytes.count else { throw VisualWireError.malformed }
            return value
        }
    }

    struct Reader {
        let bytes: UnsafeBufferPointer<UInt8>
        var offset = 0
        var strings: [String] = []

        init(bytes: UnsafeBufferPointer<UInt8>) {
            self.bytes = bytes
        }

        mutating func byte() throws -> UInt8 {
            guard offset < bytes.count else { throw VisualWireError.truncated }
            defer { offset += 1 }
            return bytes[offset]
        }

        mutating func varint() throws -> UInt64 {
            var result: UInt64 = 0
            var shift: UInt64 = 0
            while true {
                let byte = try self.byte()
                guard shift < 64 else { throw VisualWireError.malformed }
                result |= UInt64(byte & 0x7f) << shift
                if byte & 0x80 == 0 { return result }
                shift += 7
            }
        }

        /// A count can't exceed the bytes left, since every element takes at least one byte.
        mutating func count() throws -> Int {
            let count = try varint()
            guard count <= UInt64(bytes.count - offset) else { throw VisualWireError.truncated }
            return Int(count)
        }

        mutating func string() throws -> String {
            let header = try varint()
            if header & 1 == 0 {
                let index = header >> 1
                guard index < UInt64(strings.count) else { throw VisualWireError.malformed }
                return strings[Int(index)]
            }
            let length = header >> 1
            guard length <= UInt64(bytes.count - offset) else { throw VisualWireError.truncated }
            let end = offset + Int(length)
            let text = String(decoding: UnsafeBufferPointer(rebasing: bytes[offset..<end]), as: UTF8.self)
            offset = end
            if length <= UInt64(VisualWire.internMaxLength), strings.count < VisualWire.internLimit {
                strings.append(text)
            }
            return text
        }

        mutating func value(depth: Int) throws -> VisualValue {
            guard depth <= VisualWire.maxDepth else { throw VisualWireError.tooDeep }
            guard let tag = Tag(rawValue: try byte()) else { throw VisualWireError.malformed }
            switch tag {
            case .null: return .null
            case .falseValue: return .bool(false)
            case .trueValue: return .bool(true)
            case .integer:
                let zigzag = try varint()
                let integer = Int64(bitPattern: (zigzag >> 1) ^ (0 &- (zigzag & 1)))
                return .number(Double(integer))
            case .float:
                guard bytes.count - offset >= 8 else { throw VisualWireError.truncated }
                var bits: UInt64 = 0
                for index in 0..<8 { bits |= UInt64(bytes[offset + index]) << (8 * UInt64(index)) }
                offset += 8
                let number = Double(bitPattern: bits)
                return number.isFinite ? .number(number) : .null
            case .string:
                return .string(try string())
            case .array:
                let count = try count()
                var items: [VisualValue] = []
                items.reserveCapacity(count)
                for _ in 0..<count { items.append(try value(depth: depth + 1)) }
                return .array(items)
            case .object:
                let count = try count()
                var entries: [VisualObject.Entry] = []
                entries.reserveCapacity(count)
                for _ in 0..<count {
                    let key = try string()
                    entries.append(VisualObject.Entry(key, try value(depth: depth + 1)))
                }
                return .object(VisualObject(entries))
            }
        }
    }

    // MARK: Encoding

    public static func encode(_ value: VisualValue) -> Data {
        var writer = Writer()
        writer.bytes.append(contentsOf: magic)
        writer.value(value)
        return Data(writer.bytes)
    }

    struct Writer {
        var bytes: [UInt8] = []
        /// Keyed by bytes: Swift's String equality is canonical, so "é" composed and decomposed would collide.
        var strings: [[UInt8]: Int] = [:]

        mutating func varint(_ value: UInt64) {
            var value = value
            repeat {
                var byte = UInt8(value & 0x7f)
                value >>= 7
                if value != 0 { byte |= 0x80 }
                bytes.append(byte)
            } while value != 0
        }

        mutating func string(_ text: String) {
            let utf8 = Array(text.utf8)
            if utf8.count <= VisualWire.internMaxLength, let index = strings[utf8] {
                varint(UInt64(index) << 1)
                return
            }
            varint(UInt64(utf8.count) << 1 | 1)
            bytes.append(contentsOf: utf8)
            if utf8.count <= VisualWire.internMaxLength, strings.count < VisualWire.internLimit {
                strings[utf8] = strings.count
            }
        }

        mutating func value(_ value: VisualValue) {
            switch value {
            case .null:
                bytes.append(Tag.null.rawValue)
            case .bool(let flag):
                bytes.append(flag ? Tag.trueValue.rawValue : Tag.falseValue.rawValue)
            case .number(let number):
                if !number.isFinite {
                    bytes.append(Tag.null.rawValue)
                } else if number == number.rounded(), abs(number) <= 9_007_199_254_740_992 {
                    bytes.append(Tag.integer.rawValue)
                    let integer = Int64(number)
                    varint(UInt64(bitPattern: (integer << 1) ^ (integer >> 63)))
                } else {
                    bytes.append(Tag.float.rawValue)
                    let bits = number.bitPattern
                    for index in 0..<8 { bytes.append(UInt8(truncatingIfNeeded: bits >> (8 * UInt64(index)))) }
                }
            case .string(let text):
                bytes.append(Tag.string.rawValue)
                string(text)
            case .array(let items):
                bytes.append(Tag.array.rawValue)
                varint(UInt64(items.count))
                for item in items { self.value(item) }
            case .object(let object):
                bytes.append(Tag.object.rawValue)
                varint(UInt64(object.entries.count))
                for entry in object.entries {
                    string(entry.key)
                    self.value(entry.value)
                }
            }
        }
    }
}
