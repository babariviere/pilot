import Foundation
import PilotVisualsHost
import PilotVisualsKit
import Testing

struct VisualEngineClientTests {
    @Test(.timeLimit(.minutes(1))) func restartsAReleasedEngineFromItsSavedState() async throws {
        var configuration = VisualHost.Configuration()
        configuration.capacity = 1
        let transport = InProcessTransport(host: VisualHost(configuration: configuration))
        let client = VisualEngineClient(transport: transport)
        _ = await client.load("a", request(counterVisual, data: #"{"start":0}"#))
        _ = await client.event("a", handler: increment, value: nil)
        // Loading b releases a's engine in the service.
        _ = await client.load("b", request(counterVisual, data: #"{"start":0}"#))
        let resumed = await client.event("a", handler: increment, value: nil)
        #expect(resumed.stateText == #"{"count":2}"#)
        #expect(transport.loads == 3)
    }

    @Test(.timeLimit(.minutes(1))) func reportsACrashThenRecoversOnTheNextRequest() async {
        let transport = InProcessTransport(host: VisualHost())
        let client = VisualEngineClient(transport: transport)
        _ = await client.load("a", request(counterVisual, data: #"{"start":5}"#))
        transport.crashNext()
        #expect(await client.event("a", handler: increment, value: nil) == .failure(.crashed))
        // The service lost every engine. The next event restarts a from its last saved state.
        let next = await client.event("a", handler: increment, value: nil)
        #expect(next.stateText == #"{"count":6}"#)
    }

    @Test(.timeLimit(.minutes(1))) func keepsEventsForOneVisualInOrder() async {
        let client = VisualEngineClient(transport: InProcessTransport(host: VisualHost()))
        _ = await client.load("a", request(counterVisual, data: #"{"start":0}"#))
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<20 {
                group.addTask { _ = await client.event("a", handler: increment, value: nil) }
            }
        }
        let last = await client.event("a", handler: increment, value: nil)
        #expect(last.stateText == #"{"count":21}"#)
    }

    @Test(.timeLimit(.minutes(1))) func releasedVisualsAreNotRestarted() async {
        let client = VisualEngineClient(transport: InProcessTransport(host: VisualHost()))
        _ = await client.load("a", request(counterVisual, data: #"{"start":0}"#))
        await client.release("a")
        let event = await client.event("a", handler: increment, value: nil)
        #expect(event == .failure(.unavailable("This visual is no longer loaded.")))
    }

    @Test(.timeLimit(.minutes(1))) func unbundledBuildsReportTheServiceAsUnavailable() async {
        // Test processes have no XPCServices directory, so the connection is invalidated at once.
        let client = VisualEngineClient(transport: VisualXPCTransport(timeout: 10))
        let result = await client.load("a", request(counterVisual, data: #"{"start":0}"#))
        guard case .failure(.unavailable) = result else {
            Issue.record("expected the service to be unavailable, got \(result)")
            return
        }
    }
}

