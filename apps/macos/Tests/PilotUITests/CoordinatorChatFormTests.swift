import PilotCore
import Testing
@testable import Pilot

@Test func coordinatorFormWaitsForModelsAndPreservesOptionalChoices() {
    var form = CoordinatorChatForm()
    #expect(MissionForm().coordinator, "New mission starts a coordinator by default")
    #expect(!form.canStart)
    #expect(form.request.model == nil)
    #expect(form.request.thinking == nil)
    form.loading = false
    #expect(!form.canStart, "an empty scope cannot start a chat")
    form.models = ModelList(models: [ModelOption(id: "test/model", provider: "test", name: "Test model")])
    #expect(form.canStart)
    form.error = "Could not load models"
    #expect(!form.canStart)
    form.error = nil
    form.model = "test/model"
    form.thinking = "high"
    form.message = "Keep compatibility. https://example.com/spec"
    #expect(form.request.model == "test/model")
    #expect(form.request.thinking == "high")
    #expect(form.request.message == form.message)
}
