import Foundation
import Testing
import PilotCore

@Test(arguments: ["failed", "prepared", "cancelled"])
func controlPreparationEvidenceDecodesWithoutInferringTaskSuccess(outcome: String) throws {
    let reference = "diagnostic:v1:control-preparation:00000000-0000-4000-8000-000000000002"
    let data = Data(#"""
    {"ref":"\#(reference)","attemptRef":"\#(reference)","source":"request_timing",
     "at":"2026-01-01T00:00:00.000Z","kind":"control.request.preparation",
     "outcome":"\#(outcome)","stage":"history_summarization","durationMs":2}
    """#.utf8)
    let evidence = try JSONDecoder().decode(DiagnosticEvidence.self, from: data)
    #expect(evidence.source == .requestTiming)
    #expect(evidence.kind == "control.request.preparation")
    #expect(evidence.outcome == outcome)
    #expect(evidence.attemptRef == reference)
    #expect(evidence.stage == "history_summarization")
    #expect(evidence.durationMs == 2)
    #expect(evidence.state == nil)
    #expect(evidence.requestSource == nil)
}

@Test func diagnosticProtocolDecodesBoundedEvidenceAndHostIdentity() throws {
    let data = Data(#"""
    {
      "schemaVersion":1,
      "host":{"hostId":"devbox","daemonId":"daemon","lineageId":"lineage"},
      "sessionId":"session",
      "release":"1.0.0",
      "collectedAt":"2026-01-01T00:00:00.000Z",
      "freshness":"fresh",
      "connectivity":{"state":"online","observedAt":"2026-01-01T00:00:00.000Z"},
      "current":{"state":"parked","working":false,"pauses":[],"recovery":"none","hasError":false,
        "queue":{"pendingInputs":0,"starting":false,"parking":false,"workspacePreparing":false,
          "runningJobs":0,"workingSubagents":0}},
      "resources":{"daemonUptimeMs":1000,"eventLoopUtilization":0.1},
      "sources":[{"source":"request_timing","freshness":"stale","observedAt":"2025-12-31T23:00:00.000Z",
        "available":1,"invalid":0,"truncated":false}],
      "evidence":[{"ref":"diagnostic:v1:request:1:1","source":"request_timing",
        "at":"2025-12-31T23:00:00.000Z","kind":"model.request","outcome":"completed",
        "requestSource":"generation","preparationMs":1,"providerMs":2,"totalMs":3,"httpAttempts":1}],
      "truncation":{"truncated":false,"returned":1,"available":1,"dropped":0,"invalid":0,
        "encodedBytes":100,"maxItems":128,"maxBytes":65536}
    }
    """#.utf8)
    let result = try JSONDecoder().decode(SessionDiagnostics.self, from: data)
    #expect(result.host == HostRef(hostId: "devbox", daemonId: "daemon", lineageId: "lineage"))
    #expect(result.sources.first?.source == .requestTiming)
    #expect(result.evidence.first?.requestSource == "generation")
    #expect(result.truncation.maxBytes == 65_536)
}
