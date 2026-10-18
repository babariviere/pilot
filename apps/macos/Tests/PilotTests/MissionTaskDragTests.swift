import AppKit
import Testing
import UniformTypeIdentifiers
@testable import Pilot

@Test(.timeLimit(.minutes(1))) @MainActor
func missionTaskDragLoadsItsPlainTextOnTheMainActor() async throws {
    let taskId = "task-42"
    let provider = MissionTaskDrag.provider(taskId)
    #expect(provider.hasItemConformingToTypeIdentifier(UTType.utf8PlainText.identifier))
    let data: Data? = await withCheckedContinuation { continuation in
        _ = provider.loadDataRepresentation(forTypeIdentifier: UTType.utf8PlainText.identifier) { data, _ in
            continuation.resume(returning: data)
        }
    }
    let loaded = try #require(data)
    #expect(String(data: loaded, encoding: .utf8) == taskId)
}
