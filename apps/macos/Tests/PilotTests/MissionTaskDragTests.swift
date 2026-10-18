import AppKit
import Testing
import UniformTypeIdentifiers
@testable import Pilot

@Test(.timeLimit(.minutes(1))) @MainActor
func missionTaskDragLoadsItsPlainTextOnTheMainActor() async throws {
    let taskId = "task-42"
    let provider = MissionTaskDrag.provider(taskId)
    #expect(provider.hasItemConformingToTypeIdentifier(UTType.utf8PlainText.identifier))
    let data = try await provider.loadDataRepresentation(forTypeIdentifier: UTType.utf8PlainText.identifier)
    #expect(String(data: data, encoding: .utf8) == taskId)
}
