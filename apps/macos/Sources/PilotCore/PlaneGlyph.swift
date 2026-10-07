import CoreGraphics

/// The plane from `Resources/AppIcon.svg`, nose up and centered near the origin, in SVG units.
/// Keep `svgPath` identical to the icon's `#plane` path (a test checks it).
public enum PlaneGlyph {
    public static let svgPath =
        "M 0 -300 C 17 -300 26 -286 26 -262 L 26 -72 L 276 44 Q 290 51 290 66 L 290 72 Q 290 84 277 81 L 26 30 L 26 168 L 108 222 Q 116 228 116 238 L 116 244 Q 116 254 105 252 L 12 236 Q 0 262 -12 236 L -105 252 Q -116 254 -116 244 L -116 238 Q -116 228 -108 222 L -26 168 L -26 30 L -277 81 Q -290 84 -290 72 L -290 66 Q -290 51 -276 44 L -26 -72 L -26 -262 C -26 -286 -17 -300 0 -300 Z"

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
