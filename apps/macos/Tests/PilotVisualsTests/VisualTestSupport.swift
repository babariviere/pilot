import Foundation
import PilotVisualsHost
import PilotVisualsKit

/// A minimal stand-in for the shared visual runtime (packages/artifacts/src/visual/runtime.js) with its host
/// contract: evaluating it returns { load, render, event, state, logs }. Handlers become their path in the tree.
let testRuntime = #"""
(() => {
  "use strict";
  let view;
  let handlers = new Map();
  let saved = {};
  let seed = 0;
  let now = 0;
  const RealDate = Date;
  Math.random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  globalThis.Date = function Date(...args) { return args.length ? new RealDate(...args) : new RealDate(now); };
  globalThis.Date.now = () => now;
  globalThis.Date.prototype = RealDate.prototype;
  const strip = (value, path) => {
    if (typeof value === "function") { handlers.set(path, value); return path; }
    if (Array.isArray(value)) return value.map((item, index) => strip(item, path + "/" + index));
    if (value && typeof value === "object") {
      const out = {};
      for (const key of Object.keys(value)) out[key] = strip(value[key], path + "/" + key);
      return out;
    }
    return value;
  };
  const ui = {
    text: (text) => ({ type: "text", text }),
    column: (children) => ({ type: "column", children }),
    button: (label, onClick) => ({ type: "button", label, onClick }),
  };
  return {
    load(fn, source, dataJson, stateJson, seedText, nowValue) {
      if (typeof fn !== "function") throw new Error("source must be a function expression");
      seed = 0;
      for (const unit of seedText) seed = (Math.imul(seed, 31) + unit.charCodeAt(0)) >>> 0;
      now = nowValue;
      saved = stateJson === undefined ? {} : JSON.parse(stateJson);
      const state = (initial) => {
        for (const key of Object.keys(initial)) if (!(key in saved)) saved[key] = initial[key];
        return saved;
      };
      const result = fn({ ui, state, data: JSON.parse(dataJson) });
      view = typeof result === "function" ? result : () => result;
    },
    render(nowValue) {
      now = nowValue;
      handlers = new Map();
      return JSON.stringify({ api: 1, root: strip(view(), "0") });
    },
    event(id, valueJson, nowValue) {
      now = nowValue;
      const handler = handlers.get(id);
      if (!handler) throw new Error("no control with id " + id);
      const before = JSON.stringify(saved);
      handler(valueJson === undefined ? null : JSON.parse(valueJson));
      return JSON.stringify({ changed: before === JSON.stringify(saved) ? [] : Object.keys(saved) });
    },
    state() { return JSON.stringify(saved); },
    logs() { return "[]"; },
  };
})();
"""#

let counterVisual = #"""
function visual({ ui, state, data }) {
  const s = state({ count: data.start });
  return () => ui.column([
    ui.text("count " + s.count),
    ui.button("+", () => { s.count += 1; }),
  ]);
}
"""#

/// The counter's button handler.
let increment = "0/children/1/onClick"

func request(_ source: String, data: String = "null", state: String? = nil, seed: String = "artifact-1")
    -> VisualLoadRequest {
    VisualLoadRequest(runtime: testRuntime, source: source, data: Data(data.utf8), state: state.map { Data($0.utf8) },
                      seed: seed, now: 1_700_000_000_000)
}

extension VisualHost {
    func load(_ id: String, _ request: VisualLoadRequest) async -> Result<VisualFrame, VisualFailure> {
        await withCheckedContinuation { continuation in
            load(id, request) { continuation.resume(returning: VisualReply.decode($0)) }
        }
    }

    func event(_ id: String, _ handler: String, _ value: VisualValue = nil) async -> Result<VisualFrame, VisualFailure> {
        await withCheckedContinuation { continuation in
            event(id, handler: handler, value: value.jsonData) { continuation.resume(returning: VisualReply.decode($0)) }
        }
    }
}

extension Result where Success == VisualFrame, Failure == VisualFailure {
    var frame: VisualFrame? {
        if case .success(let frame) = self { return frame }
        return nil
    }

    var root: VisualValue? { frame?.tree["root"] }

    var scriptError: VisualScriptError? {
        if case .failure(.script(let error)) = self { return error }
        return nil
    }

    var stateText: String? { frame.map { String(decoding: $0.state, as: UTF8.self) } }
}

/// Runs the service's host in process, as the XPC service would.
final class InProcessTransport: VisualTransport, @unchecked Sendable {
    let host: VisualHost
    private let lock = NSLock()
    private var crashes = 0
    private var loadCount = 0

    var loads: Int { lock.withLock { loadCount } }

    init(host: VisualHost) {
        self.host = host
    }

    /// The next request fails as if the service crashed, losing every engine.
    func crashNext() {
        lock.withLock { crashes += 1 }
    }

    func send(_ message: VisualMessage) async -> Result<Data, VisualFailure> {
        let crash = lock.withLock {
            if case .load = message { loadCount += 1 }
            guard crashes > 0 else { return false }
            crashes -= 1
            return true
        }
        if crash {
            for id in host.liveIDs { host.release(id) }
            return .failure(.crashed)
        }
        return await withCheckedContinuation { continuation in
            switch message {
            case .load(let id, let request):
                host.load(id, request) { continuation.resume(returning: .success($0)) }
            case .event(let id, let handler, let value):
                host.event(id, handler: handler, value: value) { continuation.resume(returning: .success($0)) }
            case .probe:
                continuation.resume(returning: .success(VisualWire.encode(VisualSandboxProbe.run())))
            }
        }
    }

    func release(_ id: String) {
        host.release(id)
    }
}
