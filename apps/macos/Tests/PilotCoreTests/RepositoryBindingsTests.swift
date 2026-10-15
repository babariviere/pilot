import Foundation
import Testing
@testable import PilotCore

@Test func repositoryBindingsRequireExplicitHostMappingAndFenceStaleEdits() throws {
    let local = HostRef(hostId: "local", daemonId: "same", lineageId: "a")
    let remote = HostRef(hostId: "box", daemonId: "same", lineageId: "a")
    var bindings = RepositoryBindings()
    let localProject = HostResourceRef(host: local, kind: .project, localId: "same")
    let remoteProject = HostResourceRef(host: remote, kind: .project, localId: "same")
    _ = try bindings.confirm(logicalProjectId: "logical", project: localProject, remotePath: "/repo",
                             expectedGeneration: nil)
    #expect(bindings.mapping(logicalProjectId: "logical", host: remote) == nil)
    let mapped = try bindings.confirm(logicalProjectId: "logical", project: remoteProject,
                                      remotePath: "/repo", expectedGeneration: nil)
    #expect(mapped.project != localProject)
    #expect(bindings.mappings.count == 2)
    #expect(throws: HostRoutingError.staleGeneration) {
        try bindings.confirm(logicalProjectId: "logical", project: remoteProject,
                             remotePath: "/other", expectedGeneration: nil)
    }
    #expect(bindings.mapping(logicalProjectId: "logical", host: remote)?.remotePath == "/repo")
}

