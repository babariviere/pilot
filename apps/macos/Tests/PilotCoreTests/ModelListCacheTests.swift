import PilotCore
import Testing

private func list(_ id: String) -> ModelList {
    ModelList(models: [ModelOption(id: id, provider: "p", name: id)])
}

@Test func modelListCacheKeysMirrorTheDaemonQuery() {
    #expect(ModelListCache.key(projectId: "p1", cwd: "/tmp") == "project:p1")
    #expect(ModelListCache.key(projectId: nil, cwd: "/tmp") == "cwd:/tmp")
    #expect(ModelListCache.key(projectId: nil, cwd: "") == "cwd:~")
    #expect(ModelListCache.key(projectId: nil, cwd: nil) == "cwd:~")
}

@Test func modelListCacheReplacesEntriesAndEvictsTheLeastRecentlyUsed() {
    var cache = ModelListCache(limit: 2)
    cache.store(list("a"), for: "a")
    cache.store(list("b"), for: "b")
    #expect(cache.list(for: "a") == list("a"))
    cache.store(list("c"), for: "c")
    #expect(cache.count == 2)
    #expect(cache.list(for: "b") == nil)
    #expect(cache.list(for: "a") == list("a"))
    cache.store(list("a2"), for: "a")
    #expect(cache.list(for: "a") == list("a2"))
    #expect(cache.count == 2)
}
