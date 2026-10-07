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

/// A minimal SVG path parser: absolute M, L, Q, C and Z, as written in our icon sources.
public enum SVGPath {
    public enum Command: Equatable {
        case move(CGPoint)
        case line(CGPoint)
        case quad(control: CGPoint, to: CGPoint)
        case cubic(control1: CGPoint, control2: CGPoint, to: CGPoint)
        case close
    }

    public static func parse(_ data: String) -> [Command] {
        let tokens = data.replacingOccurrences(of: ",", with: " ").split(whereSeparator: \.isWhitespace).map(String.init)
        var commands: [Command] = []
        var index = 0
        var current: Character?
        func point() -> CGPoint? {
            guard index + 1 < tokens.count, let x = Double(tokens[index]), let y = Double(tokens[index + 1]) else { return nil }
            index += 2
            return CGPoint(x: x, y: y)
        }
        while index < tokens.count {
            if let letter = tokens[index].first, tokens[index].count == 1, letter.isLetter {
                current = letter
                index += 1
                if letter == "Z" || letter == "z" { commands.append(.close) }
                continue
            }
            switch current {
            case "M":
                guard let to = point() else { return commands }
                commands.append(.move(to))
                current = "L"
            case "L":
                guard let to = point() else { return commands }
                commands.append(.line(to))
            case "Q":
                guard let control = point(), let to = point() else { return commands }
                commands.append(.quad(control: control, to: to))
            case "C":
                guard let control1 = point(), let control2 = point(), let to = point() else { return commands }
                commands.append(.cubic(control1: control1, control2: control2, to: to))
            default:
                return commands
            }
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
}
