import AppKit
import PilotVisualsKit

/// Packaging smoke test for the visual service: it launches from this app's XPCServices, runs a visual through the
/// bundled runtime on the vendored engine and stays sandboxed (no network, no files outside its container).
@MainActor
enum VisualServiceCheck {
    static func run() async {
        func fail(_ message: String) -> Never {
            print("visuals-check failed: \(message)")
            exit(1)
        }
        guard Bundle.main.bundleURL.pathExtension == "app" else { fail("requires a packaged app") }
        let client = VisualEngineClient.shared
        let probe: VisualValue
        switch await client.probe() {
        case .success(let value): probe = value
        case .failure(let failure): fail("the service did not answer: \(failure.message)")
        }
        guard let engine = probe["engine"]?.stringValue, !engine.isEmpty else { fail("no engine version") }
        guard probe["sandboxed"]?.boolValue == true else {
            fail("the service is not sandboxed (network: \(probe["network"]?.stringValue ?? "?"), "
                + "files: \(probe["files"]?.stringValue ?? "?"))")
        }
        let request = VisualLoadRequest(
            runtime: VisualRuntime.source,
            source: "function visual({ ui, data }) { return () => ui.text(\"engine \" + data.n); }",
            data: Data(#"{"n":1}"#.utf8), seed: "visuals-check", now: 0
        )
        switch await client.load("visuals-check", request) {
        case .success(let frame):
            guard frame.tree["root"]?["runs"]?.arrayValue?.first?["text"]?.stringValue == "engine 1" else {
                fail("unexpected tree \(frame.tree)")
            }
        case .failure(let failure):
            fail("the visual did not run: \(failure.message)")
        }
        await client.release("visuals-check")
        print("visuals-check passed: QuickJS-NG \(engine) in a sandboxed service")
        exit(0)
    }
}
