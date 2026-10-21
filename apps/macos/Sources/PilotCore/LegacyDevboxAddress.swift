import Foundation

/// Historical cache coordinates, never an executable SSH configuration.
public struct LegacyDevboxAddress: Codable, Equatable, Sendable {
    public let alias: String
    public let remotePort: UInt16

    public init(alias: String, remotePort: UInt16 = 4319) throws {
        let bytes = Array(alias.utf8)
        func alphanumeric(_ byte: UInt8) -> Bool {
            (65...90).contains(byte) || (97...122).contains(byte) || (48...57).contains(byte)
        }
        guard let first = bytes.first, alphanumeric(first), bytes.count <= 255,
              bytes.allSatisfy({ alphanumeric($0) || [45, 46, 95].contains($0) }), remotePort != 0 else {
            throw HostRoutingError.invalidReference
        }
        self.alias = alias
        self.remotePort = remotePort
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(alias: values.decode(String.self, forKey: .alias),
                      remotePort: values.decode(UInt16.self, forKey: .remotePort))
    }
}
