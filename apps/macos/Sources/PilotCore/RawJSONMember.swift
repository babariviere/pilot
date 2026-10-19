import Foundation

/// Finds one member of a JSON document's top-level object and returns its value's text unchanged, so callers keep
/// what decoding into dictionaries loses, such as object key order. Returns nil for malformed documents.
public enum RawJSONMember {
    public static func value(of name: String, in json: Data) -> Data? {
        let bytes = [UInt8](json)
        var scanner = Scanner(bytes: bytes)
        scanner.skipSpace()
        guard scanner.take(UInt8(ascii: "{")) else { return nil }
        scanner.skipSpace()
        if scanner.take(UInt8(ascii: "}")) { return nil }
        while true {
            scanner.skipSpace()
            guard let key = scanner.string() else { return nil }
            scanner.skipSpace()
            guard scanner.take(UInt8(ascii: ":")) else { return nil }
            scanner.skipSpace()
            let start = scanner.offset
            guard scanner.skipValue(depth: 0) else { return nil }
            if key == name { return Data(bytes[start..<scanner.offset]) }
            scanner.skipSpace()
            if scanner.take(UInt8(ascii: ",")) { continue }
            return nil
        }
    }

    private struct Scanner {
        let bytes: [UInt8]
        var offset = 0

        init(bytes: [UInt8]) {
            self.bytes = bytes
        }

        var current: UInt8? { offset < bytes.count ? bytes[offset] : nil }

        mutating func take(_ byte: UInt8) -> Bool {
            guard current == byte else { return false }
            offset += 1
            return true
        }

        mutating func skipSpace() {
            while let byte = current, byte == 0x20 || byte == 0x0A || byte == 0x0D || byte == 0x09 { offset += 1 }
        }

        /// A string, decoded, for comparing keys.
        mutating func string() -> String? {
            let start = offset
            guard skipString() else { return nil }
            let text = Data(bytes[start..<offset])
            return try? JSONDecoder().decode(String.self, from: text)
        }

        mutating func skipString() -> Bool {
            guard take(UInt8(ascii: "\"")) else { return false }
            while let byte = current {
                offset += 1
                if byte == UInt8(ascii: "\\") {
                    guard current != nil else { return false }
                    offset += 1
                } else if byte == UInt8(ascii: "\"") {
                    return true
                }
            }
            return false
        }

        mutating func skipValue(depth: Int) -> Bool {
            guard depth < 512, let byte = current else { return false }
            switch byte {
            case UInt8(ascii: "\""):
                return skipString()
            case UInt8(ascii: "{"), UInt8(ascii: "["):
                let close = byte == UInt8(ascii: "{") ? UInt8(ascii: "}") : UInt8(ascii: "]")
                offset += 1
                skipSpace()
                if take(close) { return true }
                while true {
                    skipSpace()
                    if byte == UInt8(ascii: "{") {
                        guard skipString() else { return false }
                        skipSpace()
                        guard take(UInt8(ascii: ":")) else { return false }
                        skipSpace()
                    }
                    guard skipValue(depth: depth + 1) else { return false }
                    skipSpace()
                    if take(close) { return true }
                    guard take(UInt8(ascii: ",")) else { return false }
                }
            default:
                // Numbers, true, false and null: up to the next delimiter.
                let start = offset
                while let next = current, !Self.delimiters.contains(next) { offset += 1 }
                return offset > start
            }
        }

        static let delimiters: Set<UInt8> = [0x20, 0x0A, 0x0D, 0x09, UInt8(ascii: ","), UInt8(ascii: "}"),
                                             UInt8(ascii: "]"), UInt8(ascii: ":")]
    }
}
