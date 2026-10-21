import Foundation
import PilotVisualsHost
import PilotVisualsKit
import Testing

struct VisualHostTests {
    @Test(.timeLimit(.minutes(1))) func loadsAVisualAndRunsItsHandlers() async throws {
        let host = VisualHost()
        let loaded = await host.load("a", request(counterVisual, data: #"{"start":3}"#))
        let root = try #require(loaded.root)
        #expect(loaded.frame?.tree["api"] == 1)
        #expect(root["type"] == "column")
        #expect(root["children"]?.arrayValue?[0]["text"] == "count 3")
        #expect(root["children"]?.arrayValue?[1]["onClick"] == .string(increment))
        #expect(loaded.stateText == #"{"count":3}"#)
        #expect(loaded.frame?.changed == nil)

        let clicked = await host.event("a", increment)
        #expect(clicked.root?["children"]?.arrayValue?[0]["text"] == "count 4")
        #expect(clicked.stateText == #"{"count":4}"#)
        #expect(clicked.frame?.changed == ["count"])
        host.release("a")
        #expect(host.liveIDs.isEmpty)
    }

    @Test(.timeLimit(.minutes(1))) func restoresSavedState() async {
        let host = VisualHost()
        let restored = await host.load("a", request(counterVisual, data: #"{"start":3}"#, state: #"{"count":41}"#))
        #expect(restored.root?["children"]?.arrayValue?[0]["text"] == "count 41")
    }

    @Test(.timeLimit(.minutes(1))) func sameInputsDrawTheSameTree() async {
        let source = #"""
        ({ ui }) => () => ui.text(Math.random() + " " + Date.now() + " " + new Date(0).getHours() + " " + (0.1 + 0.2))
        """#
        let host = VisualHost()
        let first = await host.load("a", request(source, seed: "artifact-1"))
        let second = await host.load("b", request(source, seed: "artifact-1"))
        let other = await host.load("c", request(source, seed: "artifact-2"))
        #expect(first.frame != nil)
        #expect(first.frame == second.frame)
        #expect(first.root?["text"] != other.root?["text"])
        // Local time is UTC whatever the process's time zone, as in the kernel's pre-check.
        #expect(first.root?["text"]?.stringValue?.contains(" 1700000000000 0 0.30000000000000004") == true)
    }

    @Test(.timeLimit(.minutes(1))) func encodesTheTreeFaithfully() async throws {
        let source = #"""
        () => () => ({ a: NaN, b: [1.5, 2 ** 60, -7, "é 👋", null, true], c: {} })
        """#
        let root = try #require(await VisualHost().load("a", request(source)).root)
        #expect(root == ["a": nil, "b": [1.5, .number(pow(2, 60)), -7, "é 👋", nil, true], "c": [:]])
    }

    @Test(.timeLimit(.minutes(1))) func scriptsSeeNoHostOrIO() async throws {
        let source = #"""
        () => () => [typeof WeakRef, typeof FinalizationRegistry, typeof std, typeof os, typeof setTimeout,
          typeof fetch, typeof require, typeof XMLHttpRequest, typeof process].join(" ")
        """#
        let root = try #require(await VisualHost().load("a", request(source)).root)
        #expect(root == .string(Array(repeating: "undefined", count: 9).joined(separator: " ")))
    }

    @Test(.timeLimit(.minutes(1))) func interruptsLongSetupViewsAndHandlers() async throws {
        let host = VisualHost()
        let setup = await host.load("a", request("function visual() {\n  while (true) {}\n}"))
        #expect(setup.scriptError?.kind == .timeout)
        #expect(setup.scriptError?.message == "the visual function took longer than 250 ms")
        // A visual that failed to start leaves no engine behind.
        #expect(host.liveIDs.isEmpty)

        let catching = await host.load("b", request("function visual() {\n  for (;;) { try { for (;;) {} } catch {} }\n}"))
        #expect(catching.scriptError?.kind == .timeout)

        let view = await host.load("c", request("() => () => { for (;;) {} }"))
        #expect(view.scriptError?.message == "the view took longer than 250 ms")

        let looping = #"""
        ({ ui }) => () => ui.button("spin", () => { for (;;) {} })
        """#
        #expect(await host.load("d", request(looping)).frame != nil)
        let handler = await host.event("d", "0/onClick")
        #expect(handler.scriptError?.message == "the handler took longer than 100 ms")
        // The engine survives an interrupted handler.
        #expect(await host.event("d", "0/onClick").scriptError?.kind == .timeout)
    }

    @Test(.timeLimit(.minutes(1))) func reportsMemoryAndStackExhaustionWithLines() async throws {
        let host = VisualHost()
        // Large allocations reach the heap limit in a few steps, far below the setup time limit on a slow runner.
        let memory = await host.load("a", request(
            "function visual() {\n  const chunks = [];\n  for (;;) chunks.push(new ArrayBuffer(8 * 1024 * 1024));\n}"))
        let memoryError = try #require(memory.scriptError)
        #expect(memoryError.kind == .memory)
        #expect(memoryError.message == "the visual used more than 32 MiB of memory")
        // QuickJS may be unable to allocate its OOM Error, so no source stack exists.
        // Do not invent a line, but still require correct attribution whenever metadata survived.
        #expect(memoryError.line == 3 || (memoryError.line == nil && memoryError.stack == nil))

        let stack = await host.load("b", request("function visual() {\n  const f = (n) => f(n + 1) + 1;\n  return f(0);\n}"))
        #expect(stack.scriptError?.kind == .stack)
        #expect(stack.scriptError?.message == "RangeError: Maximum call stack size exceeded")
        #expect(stack.scriptError?.line == 2)
    }

    @Test(.timeLimit(.minutes(1))) func reportsMetadataFreeMemoryErrorsWithoutInventingLines() async throws {
        let host = VisualHost()
        // QuickJS uses a null exception when it cannot allocate an OOM Error. Throwing null
        // deterministically exercises that existing fallback without relying on heap allocation order.
        let result = await host.load("a", request("function visual() {\n  throw null;\n}"))
        let error = try #require(result.scriptError)
        #expect(error.kind == .memory)
        #expect(error.message == "the visual used more than 32 MiB of memory")
        #expect(error.line == nil)
        #expect(error.stack == nil)
        #expect(VisualFailure.script(error).message == error.message)
        #expect(host.liveIDs.isEmpty)
    }

    @Test(.timeLimit(.minutes(1))) func reportsScriptErrorsWithLines() async {
        let host = VisualHost()
        let thrown = await host.load("a", request("function visual() {\n  const x = 1;\n  return () => x.y.z;\n}"))
        #expect(thrown.scriptError?.kind == .script)
        #expect(thrown.scriptError?.line == 3)
        #expect(thrown.scriptError?.message.hasPrefix("TypeError: ") == true)
        #expect(VisualFailure.script(thrown.scriptError!).message.hasPrefix("line 3: TypeError: "))

        let syntax = await host.load("b", request("function visual() {\n  return ) ;\n}"))
        #expect(syntax.scriptError?.message.hasPrefix("SyntaxError: ") == true)
        #expect(syntax.scriptError?.line == 2)

        let notAFunction = await host.load("c", request("42"))
        #expect(notAFunction.scriptError?.message == "Error: source must be a function expression")

        let strict = await host.load("d", request("() => { undeclared = 1; return () => 1; }"))
        #expect(strict.scriptError?.message.hasPrefix("ReferenceError: ") == true)

        let trailingComment = await host.load("e", request("({ ui }) => () => ui.text('ok') // done"))
        #expect(trailingComment.root?["text"] == "ok")

        let thrownString = await host.load("f", request("() => { throw 'plain'; }"))
        #expect(thrownString.scriptError?.message == "plain")
    }

    @Test(.timeLimit(.minutes(1))) func releasesTheLeastRecentlyUsedEngineBeyondCapacity() async {
        var configuration = VisualHost.Configuration()
        configuration.capacity = 2
        let host = VisualHost(configuration: configuration)
        for id in ["a", "b"] { _ = await host.load(id, request(counterVisual, data: #"{"start":0}"#)) }
        // Using a makes b the least recently used.
        _ = await host.event("a", increment)
        _ = await host.load("c", request(counterVisual, data: #"{"start":0}"#))
        #expect(host.liveIDs == ["a", "c"])
        #expect(await host.event("b", increment).scriptError?.kind == .unloaded)
        #expect(await host.event("a", increment).stateText == #"{"count":2}"#)
    }

    @Test(.timeLimit(.minutes(1))) func runsEightVisualsAtOnce() async {
        let host = VisualHost()
        let results = await withTaskGroup(of: Bool.self) { group in
            for index in 0..<VisualLimits.liveEngines {
                group.addTask {
                    let id = "v\(index)"
                    guard await host.load(id, request(counterVisual, data: "{\"start\":\(index)}")).frame != nil else {
                        return false
                    }
                    return await host.event(id, increment).stateText == "{\"count\":\(index + 1)}"
                }
            }
            return await group.reduce(into: [Bool]()) { $0.append($1) }
        }
        #expect(results == Array(repeating: true, count: VisualLimits.liveEngines))
        #expect(host.liveIDs.count == VisualLimits.liveEngines)
    }

    @Test(.timeLimit(.minutes(1))) func drawsIntoSharedMemoryOrTheReply() async throws {
        let host = VisualHost()
        _ = await host.load("a", request(counterVisual, data: #"{"start":0}"#))
        let input = VisualDrawRequest(canvas: "0", width: 300, height: 120, time: 1.5, pointer: VisualPoint(x: 4, y: 5))
        let shared = await host.draw("a", input, capacity: 4096)
        let drawing = try shared.get()
        #expect(drawing.commands == 2)
        #expect(drawing.ops == [10, 1, 7, 1, 0, 0, 0, 300, 120, 0, 20, 0, 1, 4, 5, 0, 2, 400, 0, 1, 0])
        #expect(drawing.strings == ["t=1.5"])
        // Without a buffer, or one too small, the same drawing comes back in the reply.
        #expect(await host.draw("a", input) == shared)
        #expect(await host.draw("a", input, capacity: 16) == shared)
        let still = try await host.draw("a", VisualDrawRequest(canvas: "0", width: 10, height: 10)).get()
        #expect(still.ops[13...14] == [-1, -1])
        #expect(still.strings == ["t=0"])
    }

    @Test(.timeLimit(.minutes(1))) func drawFailuresAreScriptErrors() async {
        let host = VisualHost()
        _ = await host.load("a", request(counterVisual, data: #"{"start":0}"#))
        guard case .failure(.script(let spin)) = await host.draw("a", VisualDrawRequest(canvas: "spin", width: 10, height: 10))
        else {
            Issue.record("expected a timeout")
            return
        }
        #expect(spin.kind == .timeout)
        #expect(spin.message == "the drawing took longer than 8 ms")
        // The engine survives an interrupted draw.
        #expect((try? await host.draw("a", VisualDrawRequest(canvas: "0", width: 10, height: 10)).get()) != nil)
        guard case .failure(.script(let missing)) = await host.draw("a", VisualDrawRequest(canvas: "9", width: 1, height: 1))
        else {
            Issue.record("expected a script error")
            return
        }
        #expect(missing.message == "Error: no canvas with id 9")
        guard case .failure(.script(let unloaded)) = await host.draw("b", VisualDrawRequest(canvas: "0", width: 1, height: 1))
        else {
            Issue.record("expected an unloaded error")
            return
        }
        #expect(unloaded.kind == .unloaded)
    }
}
