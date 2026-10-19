import Foundation

/// Messages from Pilot to the sandboxed PilotVisuals XPC service, which runs visual scripts. Replies are messages in
/// the visual wire encoding (VisualWire): see VisualReply.
@objc public protocol VisualServiceProtocol {
    /// Starts visual id from its function source, JSON data and saved JSON state (nil for a fresh visual),
    /// replacing any engine already running under id.
    func load(_ id: String, runtime: String, source: String, data: Data, state: Data?, seed: String, now: Double,
              reply: @escaping (Data) -> Void)
    /// Runs the handler of control id (from the visual's last tree) with a JSON value, then its view.
    func event(_ id: String, handler: String, value: Data, reply: @escaping (Data) -> Void)
    /// Releases visual id's engine.
    func release(_ id: String)
    /// Shares the region canvas drawings are written to (VisualDrawRing). Sent once per connection, before any draw.
    func attach(_ region: VisualSharedRegion)
    /// Runs the draw function of canvas `canvas` in visual id's last tree. Replies the drawing's byte count when it
    /// was written to ring slot `slot`; otherwise 0 and the drawing ("PD") or an error envelope ("PV") as data.
    func draw(_ id: String, canvas: String, width: Double, height: Double, time: Double, pointerX: Double,
              pointerY: Double, hasPointer: Bool, slot: Int, reply: @escaping (Int, Data?) -> Void)
    /// Reports the engine version and whether the service is sandboxed. Used by packaging smoke tests.
    func probe(_ reply: @escaping (Data) -> Void)
}

/// Limits from docs/native-visuals.md, identical to the kernel's publish-time pre-check. The engine reports a
/// breach in the pre-check's words ("the handler took longer than 100 ms").
public enum VisualLimits {
    public static let heapBytes = 32 << 20
    public static let stackBytes = 512 << 10
    public static let setupMilliseconds: UInt32 = 250
    public static let viewMilliseconds: UInt32 = 250
    public static let handlerMilliseconds: UInt32 = 100
    /// One canvas draw: a 120 Hz frame. Two misses in a row stop the canvas.
    public static let drawMilliseconds: UInt32 = 8
    /// Live engines in the service; the least recently used one is released first.
    public static let liveEngines = 8
}

public enum VisualService {
    /// The XPC service's bundle identifier, inside Pilot.app/Contents/XPCServices.
    public static let name = "com.babariviere.pilot.visuals"
}

/// What a visual needs to start, and to start again after its engine was released or the service relaunched.
public struct VisualLoadRequest: Hashable, Sendable {
    /// The shared visual runtime script (packages/artifacts/src/visual/runtime.js), which defines ui and state.
    public var runtime: String
    /// The visual function's source text, as published with String(visual).
    public var source: String
    /// The visual's data as JSON.
    public var data: Data
    /// Saved state as JSON, or nil for a fresh visual.
    public var state: Data?
    /// The artifact id. The runtime seeds Math.random from it, so a visual draws the same way everywhere.
    public var seed: String
    /// Date.now inside the visual, in milliseconds since 1970. Fixed for the visual's life.
    public var now: Double

    public init(runtime: String, source: String, data: Data, state: Data? = nil, seed: String, now: Double) {
        self.runtime = runtime
        self.source = source
        self.data = data
        self.state = state
        self.seed = seed
        self.now = now
    }
}

/// One canvas draw: the canvas's id (its path in the tree), the area in points, the time in seconds since the canvas
/// started animating (0 when it does not), and the pointer over it, if any.
public struct VisualDrawRequest: Hashable, Sendable {
    public var canvas: String
    public var width: Double
    public var height: Double
    public var time: Double
    public var pointer: VisualPoint?

    public init(canvas: String, width: Double, height: Double, time: Double = 0, pointer: VisualPoint? = nil) {
        self.canvas = canvas
        self.width = width
        self.height = height
        self.time = time
        self.pointer = pointer
    }
}

public struct VisualPoint: Hashable, Sendable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

/// A rendered result: the node tree ({"api":1,"root":Node}) and the state to save for this artifact revision.
public struct VisualFrame: Hashable, Sendable {
    public var tree: VisualValue
    /// State as JSON text, ready to store and to pass back in a later VisualLoadRequest.
    public var state: Data
    /// After an event, the state keys its handler assigned.
    public var changed: [String]?

    public init(tree: VisualValue, state: Data, changed: [String]? = nil) {
        self.tree = tree
        self.state = state
        self.changed = changed
    }
}

/// An error the visual itself caused, reported by the engine.
public struct VisualScriptError: Error, Hashable, Sendable {
    public enum Kind: String, Sendable {
        case timeout, memory, stack, script, result, state, unloaded, unknown
    }

    public var kind: Kind
    public var message: String
    /// A line inside the visual function, when the error came from it.
    public var line: Int?
    public var stack: String?

    public init(kind: Kind, message: String, line: Int? = nil, stack: String? = nil) {
        self.kind = kind
        self.message = message
        self.line = line
        self.stack = stack
    }
}

public enum VisualFailure: Error, Hashable, Sendable {
    /// The visual threw, timed out or exceeded a limit.
    case script(VisualScriptError)
    /// The service stopped while handling the request. The next request relaunches it.
    case crashed
    /// The service is missing or refused the connection, for example in an unbundled build.
    case unavailable(String)
    /// The service did not answer in time. The connection is reset, so the next request starts over.
    case timedOut
    /// The reply was not a valid message.
    case invalidReply

    public var message: String {
        switch self {
        case .script(let error):
            if let line = error.line { return "line \(line): \(error.message)" }
            return error.message
        case .crashed: return "The visual engine stopped unexpectedly."
        case .unavailable(let reason): return reason
        case .timedOut: return "The visual engine did not respond."
        case .invalidReply: return "The visual engine sent an invalid reply."
        }
    }
}

/// Reply envelopes: { ok: true, tree, state, changed? } or { ok: false, error: { kind, message, line?, stack? } }.
public enum VisualReply {
    public static func decode(_ data: Data) -> Result<VisualFrame, VisualFailure> {
        guard let envelope = try? VisualWire.decode(data), let ok = envelope["ok"]?.boolValue else {
            return .failure(.invalidReply)
        }
        if ok {
            guard let tree = envelope["tree"] else { return .failure(.invalidReply) }
            let state = envelope["state"]?.stringValue ?? "[]"
            let changed = envelope["changed"]?.arrayValue?.compactMap(\.stringValue)
            return .success(VisualFrame(tree: tree, state: Data(state.utf8), changed: changed))
        }
        guard let error = envelope["error"], let message = error["message"]?.stringValue else {
            return .failure(.invalidReply)
        }
        let kind = error["kind"]?.stringValue.flatMap(VisualScriptError.Kind.init(rawValue:)) ?? .unknown
        let line = error["line"]?.numberValue.flatMap { $0 >= 1 && $0 <= 1e9 ? Int($0) : nil }
        return .failure(.script(VisualScriptError(kind: kind, message: message, line: line,
                                                  stack: error["stack"]?.stringValue)))
    }

    public static func error(_ kind: VisualScriptError.Kind, _ message: String) -> Data {
        VisualWire.encode([
            "ok": false,
            "error": ["kind": .string(kind.rawValue), "message": .string(message)],
        ])
    }
}
