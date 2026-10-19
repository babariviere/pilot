import Foundation
import XPC

/// One canvas draw's commands, decoded from the engine's "PD" encoding (pilot_visual_engine.c): ops follow
/// DRAW_FORMAT in runtime.js, and text commands refer to `strings` by index. The bytes come from the sandboxed
/// service, so decoding checks every count, and `forEach` stops at the first malformed command.
public struct VisualDrawing: Hashable, Sendable {
    public var commands: Int
    public var ops: [Double]
    public var strings: [String]

    public init(commands: Int, ops: [Double], strings: [String]) {
        self.commands = commands
        self.ops = ops
        self.strings = strings
    }

    static let header = 24

    /// Whether data is a drawing rather than an error envelope.
    public static func isDrawing(_ data: Data) -> Bool {
        data.count >= 4 && data.prefix(4).elementsEqual([0x50, 0x44, 1, 0])
    }

    public init?(_ data: Data) {
        guard Self.isDrawing(data), data.count >= Self.header else { return nil }
        let decoded: VisualDrawing? = data.withUnsafeBytes { raw in
            func u32(_ offset: Int) -> Int { Int(raw.loadUnaligned(fromByteOffset: offset, as: UInt32.self).littleEndian) }
            let commands = u32(4), opCount = u32(8), stringCount = u32(12), stringBytes = u32(16)
            let opsEnd = Self.header + opCount * 8
            guard opsEnd <= raw.count, opsEnd + stringBytes == raw.count, stringCount * 4 <= stringBytes else {
                return nil
            }
            var ops = [Double](repeating: 0, count: opCount)
            ops.withUnsafeMutableBytes { target in
                target.copyMemory(from: UnsafeRawBufferPointer(rebasing: raw[Self.header..<opsEnd]))
            }
            var strings: [String] = []
            strings.reserveCapacity(stringCount)
            var cursor = opsEnd
            for _ in 0..<stringCount {
                guard cursor + 4 <= raw.count else { return nil }
                let length = u32(cursor)
                guard cursor + 4 + length <= raw.count else { return nil }
                strings.append(String(decoding: UnsafeRawBufferPointer(rebasing: raw[(cursor + 4)..<(cursor + 4 + length)]),
                                      as: UTF8.self))
                cursor += 4 + length
            }
            guard cursor == raw.count else { return nil }
            return VisualDrawing(commands: commands, ops: ops, strings: strings)
        }
        guard let decoded else { return nil }
        self = decoded
    }

    /// Encodes like the engine. For tests and in-process hosts.
    public var encoded: Data {
        var data = Data([0x50, 0x44, 1, 0])
        let encodedStrings = strings.map { Data($0.utf8) }
        let stringBytes = encodedStrings.reduce(0) { $0 + 4 + $1.count }
        for value in [commands, ops.count, strings.count, stringBytes, 0] {
            withUnsafeBytes(of: UInt32(truncatingIfNeeded: value).littleEndian) { data.append(contentsOf: $0) }
        }
        ops.withUnsafeBytes { data.append(contentsOf: $0) }
        for string in encodedStrings {
            withUnsafeBytes(of: UInt32(string.count).littleEndian) { data.append(contentsOf: $0) }
            data.append(string)
        }
        return data
    }

    /// How a shape is painted: filled, or stroked with a line width; color is an index into VisualColor.allCases.
    public struct Paint: Hashable, Sendable {
        public var stroke: Bool
        public var color: Int
        public var opacity: Double
        public var lineWidth: Double

        public init(stroke: Bool, color: Int, opacity: Double, lineWidth: Double) {
            self.stroke = stroke
            self.color = color
            self.opacity = opacity
            self.lineWidth = lineWidth
        }
    }

    public struct Text: Hashable, Sendable {
        public var string: String
        public var x: Double
        public var y: Double
        public var color: Int
        public var opacity: Double
        /// Index into xs, sm, md, lg, xl.
        public var size: Int
        public var weight: Int
        /// 0 start, 1 center, 2 end.
        public var align: Int
        /// 0 top, 1 middle, 2 bottom.
        public var baseline: Int
        public var mono: Bool
    }

    public enum Command: Hashable, Sendable {
        case save
        case restore
        case translate(x: Double, y: Double)
        case rotate(Double)
        case scale(x: Double, y: Double)
        case opacity(Double)
        case rect(Paint, x: Double, y: Double, width: Double, height: Double, radius: Double)
        case circle(Paint, x: Double, y: Double, radius: Double)
        case line(Paint, x1: Double, y1: Double, x2: Double, y2: Double)
        case path(Paint, closed: Bool, points: ArraySlice<Double>)
        case arc(Paint, x: Double, y: Double, radius: Double, inner: Double, start: Double, end: Double)
        case text(Text)
    }

    /// Calls body with each command in order. Returns false when a malformed command stopped the walk.
    @discardableResult
    public func forEach(_ body: (Command) -> Void) -> Bool {
        let ops = ops
        var index = 0
        func take(_ count: Int) -> Int? {
            guard index + count <= ops.count else { return nil }
            defer { index += count }
            return index
        }
        func valid(_ values: ArraySlice<Double>) -> Bool { values.allSatisfy(\.isFinite) }
        func paint(_ at: Int) -> Paint? {
            let mode = ops[at], color = ops[at + 1]
            guard mode == 1 || mode == 2, color >= 0, color < Double(VisualColor.allCases.count),
                  ops[at + 2].isFinite, ops[at + 3].isFinite else { return nil }
            return Paint(stroke: mode == 2, color: Int(color), opacity: min(1, max(0, ops[at + 2])),
                         lineWidth: min(100, max(0, ops[at + 3])))
        }
        while index < ops.count {
            let op = ops[index]
            index += 1
            switch op {
            case 1: body(.save)
            case 2: body(.restore)
            case 3:
                guard let at = take(2), valid(ops[at..<at + 2]) else { return false }
                body(.translate(x: ops[at], y: ops[at + 1]))
            case 4:
                guard let at = take(1), valid(ops[at..<at + 1]) else { return false }
                body(.rotate(ops[at]))
            case 5:
                guard let at = take(2), valid(ops[at..<at + 2]) else { return false }
                body(.scale(x: ops[at], y: ops[at + 1]))
            case 6:
                guard let at = take(1), valid(ops[at..<at + 1]) else { return false }
                body(.opacity(min(1, max(0, ops[at]))))
            case 10:
                guard let at = take(9), let paint = paint(at), valid(ops[at + 4..<at + 9]) else { return false }
                body(.rect(paint, x: ops[at + 4], y: ops[at + 5], width: ops[at + 6], height: ops[at + 7],
                           radius: max(0, ops[at + 8])))
            case 11:
                guard let at = take(7), let paint = paint(at), valid(ops[at + 4..<at + 7]) else { return false }
                body(.circle(paint, x: ops[at + 4], y: ops[at + 5], radius: max(0, ops[at + 6])))
            case 12:
                guard let at = take(8), let paint = paint(at), valid(ops[at + 4..<at + 8]) else { return false }
                body(.line(paint, x1: ops[at + 4], y1: ops[at + 5], x2: ops[at + 6], y2: ops[at + 7]))
            case 13:
                guard let at = take(6), let paint = paint(at) else { return false }
                let count = ops[at + 5]
                guard count >= 0, count <= Double(ops.count), count == count.rounded(), let points = take(Int(count) * 2),
                      valid(ops[points..<points + Int(count) * 2]) else { return false }
                body(.path(paint, closed: ops[at + 4] == 1, points: ops[points..<points + Int(count) * 2]))
            case 14:
                guard let at = take(10), let paint = paint(at), valid(ops[at + 4..<at + 10]) else { return false }
                body(.arc(paint, x: ops[at + 4], y: ops[at + 5], radius: max(0, ops[at + 6]),
                          inner: max(0, ops[at + 7]), start: ops[at + 8], end: ops[at + 9]))
            case 20:
                guard let at = take(10), valid(ops[at..<at + 10]) else { return false }
                let color = ops[at], string = ops[at + 4]
                guard color >= 0, color < Double(VisualColor.allCases.count), string >= 0,
                      string < Double(strings.count) else { return false }
                body(.text(Text(string: strings[Int(string)], x: ops[at + 2], y: ops[at + 3], color: Int(color),
                                opacity: min(1, max(0, ops[at + 1])), size: min(4, max(0, Int(ops[at + 5]))),
                                weight: Int(ops[at + 6]), align: min(2, max(0, Int(ops[at + 7]))),
                                baseline: min(2, max(0, Int(ops[at + 8]))), mono: ops[at + 9] == 1)))
            default:
                return false
            }
        }
        return true
    }
}

/// A shared memory region from mmap, passed to the visual service over XPC. The app creates it; the service maps
/// the same pages. Both unmap their view when the object goes away.
public final class VisualSharedRegion: NSObject, NSSecureCoding, @unchecked Sendable {
    public static var supportsSecureCoding: Bool { true }

    public let base: UnsafeMutableRawPointer
    public let length: Int
    private let object: xpc_object_t

    /// A new zero-filled region of length bytes, rounded up to whole pages.
    public init?(length: Int) {
        let page = Int(getpagesize())
        let rounded = (length + page - 1) / page * page
        guard let base = mmap(nil, rounded, PROT_READ | PROT_WRITE, MAP_ANON | MAP_SHARED, -1, 0),
              base != MAP_FAILED else { return nil }
        self.base = base
        self.length = rounded
        object = xpc_shmem_create(base, rounded)
    }

    public init?(coder: NSCoder) {
        guard let coder = coder as? NSXPCCoder,
              let object = coder.decodeXPCObject(ofType: XPC_TYPE_SHMEM, forKey: "region") else { return nil }
        var region: UnsafeMutableRawPointer?
        let length = xpc_shmem_map(object, &region)
        guard length > 0, let region else { return nil }
        base = region
        self.length = length
        self.object = object
    }

    public func encode(with coder: NSCoder) {
        (coder as? NSXPCCoder)?.encodeXPCObject(object, forKey: "region")
    }

    deinit {
        munmap(base, length)
    }
}

/// The app's ring of drawing slots in one shared region: each draw in flight borrows a slot the service writes its
/// drawing to, so per-frame commands don't travel inside XPC messages. When every slot is busy, or a drawing
/// doesn't fit, the drawing comes back in the reply instead.
public final class VisualDrawRing: @unchecked Sendable {
    public static let slotCount = 8
    public static let slotBytes = 1 << 20

    public let region: VisualSharedRegion
    private let lock = NSLock()
    private var free: [Int]

    public init?() {
        guard let region = VisualSharedRegion(length: Self.slotCount * Self.slotBytes) else { return nil }
        self.region = region
        free = Array((0..<Self.slotCount).reversed())
    }

    public func acquire() -> Int? {
        lock.lock()
        defer { lock.unlock() }
        return free.popLast()
    }

    public func release(_ slot: Int) {
        lock.lock()
        defer { lock.unlock() }
        free.append(slot)
    }

    /// Copies a written drawing out of its slot. The service may still write to shared pages, so the copy is what
    /// gets validated and decoded.
    public func copy(slot: Int, count: Int) -> Data? {
        guard (0..<Self.slotCount).contains(slot), count > 0, count <= Self.slotBytes else { return nil }
        return Data(bytes: region.base + slot * Self.slotBytes, count: count)
    }

    /// The service's view of slot: where to write and how much fits.
    public static func slot(_ slot: Int, in region: VisualSharedRegion) -> UnsafeMutableRawBufferPointer? {
        guard (0..<slotCount).contains(slot), region.length >= slotCount * slotBytes else { return nil }
        return UnsafeMutableRawBufferPointer(start: region.base + slot * slotBytes, count: slotBytes)
    }
}
