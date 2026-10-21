import Foundation
import Testing
import PilotCore

@Test func nativeDiagnosticEvidenceKeepsDevboxSetupCorrelation() throws {
    let item = NativeDiagnosticEvidence(ref: "diagnostic:v1:setup:fixture",
        attemptRef: "diagnostic:v1:setup-attempt:fixture", sequence: 3,
        at: "2026-01-01T00:00:00.000Z", stage: .remoteHandshake, outcome: .failed,
        reason: .handshakeRejected)
    let data = try JSONEncoder().encode(item)
    let restored = try JSONDecoder().decode(NativeDiagnosticEvidence.self, from: data)
    #expect(restored == item)
    #expect(restored.attemptRef == "diagnostic:v1:setup-attempt:fixture")
    #expect(restored.stage == "remote_handshake")
    #expect(restored.sequence == 3)
    let projection = try JSONDecoder().decode(DiagnosticEvidence.self, from: data)
    #expect(projection.attemptRef == restored.attemptRef)
    #expect(projection.stage == restored.stage)
}

@Test func nativeOSDiagnosticEvidenceDoesNotInventSetupCorrelation() throws {
    let item = NativeDiagnosticEvidence(ref: "diagnostic:v1:native:fixture",
        at: "2026-01-01T00:00:00.000Z", kind: "native.hang", reason: "main_thread",
        windowMs: 1000, releaseRelation: "current", durationMs: 20)
    let restored = try JSONDecoder().decode(NativeDiagnosticEvidence.self, from: JSONEncoder().encode(item))
    #expect(restored == item)
    #expect(restored.attemptRef == nil)
    #expect(restored.stage == nil)
    #expect(restored.sequence == nil)
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
