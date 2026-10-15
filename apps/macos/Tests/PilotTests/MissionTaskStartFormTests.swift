import Foundation
import PilotCore
import Testing
@testable import Pilot

@Test func taskStartFormOmitsDefaultsSoTaskPreferencesApply() throws {
    let empty = try JSONSerialization.jsonObject(with: JSONEncoder().encode(MissionTaskStartForm().request(baseBranch: nil)))
        as? [String: Any]
    #expect(empty?.isEmpty == true, "an untouched sheet sends no model, so pilotd uses the task's preferred model")

    let artifact = try JSONDecoder().decode(MissionArtifactLink.self, from: Data(#"""
    {"artifactId":"a1","sessionId":"s1","title":"Mock","kind":"swiftui","revision":3,"linkedAt":1}
    """#.utf8))
    var form = MissionTaskStartForm()
    form.message = "  Keep it small \n"
    form.thinking = "low"
    form.mode = .ask
    form.add(artifact)
    form.add(artifact)
    form.add(MissionLinkReference(url: "https://example.com/spec", title: "Spec"))
    form.add(MissionLinkReference(url: "https://example.com/spec", title: "Again"))
    let request = form.request(baseBranch: "release")
    #expect(request.message == "Keep it small")
    #expect(request.model == nil)
    #expect(request.thinking == "low")
    #expect(request.mode == .ask)
    #expect(request.baseBranch == "release")
    #expect(request.artifacts?.map(\.artifactId) == ["a1"])
    #expect(request.artifacts?.first?.revision == 3)
    #expect(request.links?.map(\.title) == ["Spec"])
}

