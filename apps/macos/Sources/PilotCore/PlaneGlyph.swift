import CoreGraphics

/// The plane from `Resources/AppIcon.svg`, nose up and centered near the origin, in SVG units.
/// Keep `svgPath` identical to the icon's `#plane` path (a test checks it).
public enum PlaneGlyph {
    public static let svgPath =
        "M 24 -52 L 282 66 Q 290 70 290 78 L 290 86 Q 290 94 282 93 L 104 54 L 24 54 Z M -24 -52 L -24 54 L -104 54 L -282 93 Q -290 94 -290 86 L -290 78 Q -290 70 -282 66 Z M 10 200 L 112 248 Q 118 251 118 257 L 118 264 Q 118 270 112 270 L 10 266 Z M -10 200 L -10 266 L -112 270 Q -118 270 -118 264 L -118 257 Q -118 251 -112 248 Z M 0 -300 C 17 -300 27 -280 27 -244 L 27 140 C 27 200 14 260 6 292 Q 0 304 -6 292 C -14 260 -27 200 -27 140 L -27 -244 C -27 -280 -17 -300 0 -300 Z"

    /// The contrail behind the tail, in the same units. It widens and fades away from the plane.
    public static func trail(length: CGFloat) -> CGPath {
        let path = CGMutablePath()
        path.addLines(between: [
            CGPoint(x: -8, y: 262), CGPoint(x: 8, y: 262),
            CGPoint(x: 8 + 38 * length / 888, y: 262 + length), CGPoint(x: -8 - 38 * length / 888, y: 262 + length),
        ])
        path.closeSubpath()
        return path
    }

    public static var path: CGPath { SVGPath.cgPath(svgPath) }
}

/// A small SVG path parser for the app's vector marks (the app icon plane and service marks).
/// Supports M L H V C S Q T A Z, absolute and relative, implicit repeats, packed numbers and arc flags.
/// Commands are normalised to absolute moves, lines, curves and closes; arcs become cubic curves.
/// Elliptical arcs are supported, rotated arcs are not (their rotation is ignored).
public enum SVGPath {
    public enum Command: Equatable {
        case move(CGPoint)
        case line(CGPoint)
        case quad(control: CGPoint, to: CGPoint)
        case cubic(control1: CGPoint, control2: CGPoint, to: CGPoint)
        case close
    }

    public static func parse(_ data: String) -> [Command] {
        var scanner = Scanner(Array(data.utf8))
        var commands: [Command] = []
        var command = UInt8(ascii: "M")
        var point = CGPoint.zero
        var start = CGPoint.zero
        var lastControl: CGPoint?
        var lastCommand: UInt8 = 0
        while scanner.skipSeparators() {
            if let next = scanner.peek(), isCommand(next) {
                command = next
                scanner.advance()
                if next | 0x20 == UInt8(ascii: "z") {
                    commands.append(.close)
                    point = start
                    lastControl = nil
                    lastCommand = next
                    continue
                }
            }
            let relative = command >= UInt8(ascii: "a")
            let origin = relative ? point : .zero
            func pair() -> CGPoint? {
                guard let x = scanner.number(), let y = scanner.number() else { return nil }
                return CGPoint(x: origin.x + x, y: origin.y + y)
            }
            switch command | 0x20 {
            case UInt8(ascii: "m"):
                guard let p = pair() else { return commands }
                commands.append(.move(p)); point = p; start = p; lastControl = nil
                command = relative ? UInt8(ascii: "l") : UInt8(ascii: "L")
            case UInt8(ascii: "l"):
                guard let p = pair() else { return commands }
                commands.append(.line(p)); point = p; lastControl = nil
            case UInt8(ascii: "h"):
                guard let x = scanner.number() else { return commands }
                point = CGPoint(x: (relative ? point.x : 0) + x, y: point.y)
                commands.append(.line(point)); lastControl = nil
            case UInt8(ascii: "v"):
                guard let y = scanner.number() else { return commands }
                point = CGPoint(x: point.x, y: (relative ? point.y : 0) + y)
                commands.append(.line(point)); lastControl = nil
            case UInt8(ascii: "c"):
                guard let c1 = pair(), let c2 = pair(), let p = pair() else { return commands }
                commands.append(.cubic(control1: c1, control2: c2, to: p)); point = p; lastControl = c2
            case UInt8(ascii: "s"):
                let smooth = lastCommand | 0x20 == UInt8(ascii: "c") || lastCommand | 0x20 == UInt8(ascii: "s")
                let c1 = smooth ? lastControl.map { reflect($0, about: point) } ?? point : point
                guard let c2 = pair(), let p = pair() else { return commands }
                commands.append(.cubic(control1: c1, control2: c2, to: p)); point = p; lastControl = c2
            case UInt8(ascii: "q"):
                guard let c = pair(), let p = pair() else { return commands }
                commands.append(.quad(control: c, to: p)); point = p; lastControl = c
            case UInt8(ascii: "t"):
                let smooth = lastCommand | 0x20 == UInt8(ascii: "q") || lastCommand | 0x20 == UInt8(ascii: "t")
                let c = smooth ? lastControl.map { reflect($0, about: point) } ?? point : point
                guard let p = pair() else { return commands }
                commands.append(.quad(control: c, to: p)); point = p; lastControl = c
            case UInt8(ascii: "a"):
                guard let rx = scanner.number(), let ry = scanner.number(), scanner.number() != nil,
                      let large = scanner.flag(), let sweep = scanner.flag(), let end = pair() else { return commands }
                commands += arc(from: point, to: end, rx: abs(rx), ry: abs(ry), large: large, sweep: sweep)
                point = end; lastControl = nil
            default:
                return commands
            }
            lastCommand = command
        }
        return commands
    }

    public static func cgPath(_ data: String) -> CGPath {
        let path = CGMutablePath()
        for command in parse(data) {
            switch command {
            case let .move(to): path.move(to: to)
            case let .line(to): path.addLine(to: to)
            case let .quad(control, to): path.addQuadCurve(to: to, control: control)
            case let .cubic(control1, control2, to): path.addCurve(to: to, control1: control1, control2: control2)
            case .close: path.closeSubpath()
            }
        }
        return path
    }

    private static func isCommand(_ byte: UInt8) -> Bool {
        "MmLlHhVvCcSsQqTtAaZz".utf8.contains(byte)
    }

    private static func reflect(_ control: CGPoint, about point: CGPoint) -> CGPoint {
        CGPoint(x: 2 * point.x - control.x, y: 2 * point.y - control.y)
    }

    /// Endpoint arc to centre form (SVG implementation notes, appendix B.2.4), as cubic curves of at most 90°.
    private static func arc(from p0: CGPoint, to p1: CGPoint, rx: CGFloat, ry: CGFloat,
                            large: Bool, sweep: Bool) -> [Command] {
        guard rx > 0, ry > 0, p0 != p1 else { return [.line(p1)] }
        // In a space where the ellipse is a unit circle.
        let a = CGPoint(x: p0.x / rx, y: p0.y / ry)
        let b = CGPoint(x: p1.x / rx, y: p1.y / ry)
        let half = CGPoint(x: (a.x - b.x) / 2, y: (a.y - b.y) / 2)
        let d2 = half.x * half.x + half.y * half.y
        // Radii too small to join the endpoints are scaled up, as SVG specifies.
        let radius = max(1, sqrt(d2))
        var offset = sqrt(max(0, radius * radius / d2 - 1))
        if large == sweep { offset = -offset }
        let center = CGPoint(x: (a.x + b.x) / 2 + offset * half.y, y: (a.y + b.y) / 2 - offset * half.x)
        let start = atan2(a.y - center.y, a.x - center.x)
        var delta = atan2(b.y - center.y, b.x - center.x) - start
        if sweep, delta < 0 { delta += 2 * .pi }
        if !sweep, delta > 0 { delta -= 2 * .pi }
        let segments = max(1, Int(ceil(abs(delta) / (.pi / 2) - 0.001)))
        let step = delta / CGFloat(segments)
        let k = 4 / 3 * tan(step / 4)
        func point(_ angle: CGFloat) -> CGPoint {
            CGPoint(x: (center.x + radius * cos(angle)) * rx, y: (center.y + radius * sin(angle)) * ry)
        }
        func tangent(_ angle: CGFloat) -> CGPoint {
            CGPoint(x: -radius * sin(angle) * rx, y: radius * cos(angle) * ry)
        }
        return (0..<segments).map { index in
            let from = start + CGFloat(index) * step
            let to = from + step
            let p = point(from), q = point(to), dp = tangent(from), dq = tangent(to)
            return .cubic(control1: CGPoint(x: p.x + k * dp.x, y: p.y + k * dp.y),
                          control2: CGPoint(x: q.x - k * dq.x, y: q.y - k * dq.y),
                          to: index == segments - 1 ? p1 : q)
        }
    }

    private struct Scanner {
        let bytes: [UInt8]
        var index = 0

        init(_ bytes: [UInt8]) { self.bytes = bytes }

        func peek() -> UInt8? { index < bytes.count ? bytes[index] : nil }
        mutating func advance() { index += 1 }

        /// Skips whitespace and commas; false at the end of the data.
        mutating func skipSeparators() -> Bool {
            while let byte = peek(), byte == 0x20 || byte == 0x2C || byte == 0x0A || byte == 0x0D || byte == 0x09 {
                advance()
            }
            return peek() != nil
        }

        /// One arc flag, which may be packed against the next value ("01" or "1-5").
        mutating func flag() -> Bool? {
            _ = skipSeparators()
            guard let byte = peek(), byte == UInt8(ascii: "0") || byte == UInt8(ascii: "1") else { return nil }
            advance()
            return byte == UInt8(ascii: "1")
        }

        mutating func number() -> CGFloat? {
            _ = skipSeparators()
            let begin = index
            if let sign = peek(), sign == UInt8(ascii: "-") || sign == UInt8(ascii: "+") { advance() }
            var digits = false
            var dot = false
            while let byte = peek() {
                if byte >= UInt8(ascii: "0") && byte <= UInt8(ascii: "9") { digits = true; advance() }
                else if byte == UInt8(ascii: "."), !dot { dot = true; advance() }
                else { break }
            }
            if digits, let e = peek(), e == UInt8(ascii: "e") || e == UInt8(ascii: "E") {
                advance()
                if let sign = peek(), sign == UInt8(ascii: "-") || sign == UInt8(ascii: "+") { advance() }
                while let byte = peek(), byte >= UInt8(ascii: "0") && byte <= UInt8(ascii: "9") { advance() }
            }
            guard digits, let value = Double(String(decoding: bytes[begin ..< index], as: UTF8.self)) else {
                index = begin
                return nil
            }
            return CGFloat(value)
        }
    }
}
