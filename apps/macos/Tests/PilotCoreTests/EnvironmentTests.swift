import Foundation
import Testing
@testable import PilotCore

/// The Go service worked example from docs/environment-setup.md.
let goServiceProfileJSON = """
{
    "revision": 1,
    "tools": [
        { "id": "go", "version": "1.23.4", "from": { "path": "go.mod", "line": 5 } },
        { "id": "golangci-lint", "version": "1.61.0", "from": "user" }
    ],
    "services": [
        {
            "id": "postgres", "kind": "postgres", "version": "16", "provider": "pilot", "database": "orders",
            "dbTool": { "read": "allow", "write": "allow" }, "exports": { "DATABASE_URL": "url" }
        }
    ],
    "steps": [
        {
            "id": "setup", "title": "Download modules and migrate", "run": { "argv": ["make", "setup"] },
            "review": {
                "files": [{ "path": "Makefile", "sha256": "9f2c" }, { "path": "scripts/bootstrap.sh", "sha256": "41ab" }],
                "reviewedAt": 1792345678000
            },
            "inputs": ["go.sum", "migrations"], "requires": ["go", "postgres"]
        }
    ],
    "confirmedSources": [{ "path": "go.mod", "sha256": "aa" }]
}
"""

@Test func environmentProfileDecodesTheWorkedExampleAndRoundTrips() throws {
    let profile = try JSONDecoder().decode(ProjectEnvironment.self, from: Data(goServiceProfileJSON.utf8))
    #expect(profile.revision == 1)
    #expect(profile.tools.map(\.id) == ["go", "golangci-lint"])
    #expect(profile.tools[0].from == .source(path: "go.mod", line: 5))
    #expect(profile.tools[1].from == .user)
    #expect(profile.services[0].dbTool == .access(read: .allow, write: .allow))
    #expect(profile.services[0].exports == ["DATABASE_URL": .url])
    #expect(profile.steps[0].run == .argv(["make", "setup"]))
    #expect(profile.steps[0].run.displayCommand == "make setup")
    #expect(profile.steps[0].review?.files.count == 2)
    #expect(!profile.isEmpty)
    #expect(try JSONDecoder().decode(ProjectEnvironment.self, from: JSONEncoder().encode(profile)) == profile)
}

@Test func environmentUnionsEncodeTheWireShapes() throws {
    func json<T: Encodable>(_ value: T) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return String(decoding: try encoder.encode(value), as: UTF8.self)
    }
    #expect(try json(EnvironmentDbTool.hidden) == "false")
    #expect(try json(EnvironmentValueOrigin.user) == #""user""#)
    #expect(try json(EnvironmentStepRun.script(path: "scripts/setup.sh", args: ["--fast"]))
        == #"{"args":["--fast"],"script":"scripts\/setup.sh"}"#)
    #expect(try JSONDecoder().decode(EnvironmentDbTool.self, from: Data("false".utf8)) == .hidden)
    #expect(throws: DecodingError.self) { try JSONDecoder().decode(EnvironmentDbTool.self, from: Data("true".utf8)) }
    #expect(throws: DecodingError.self) {
        try JSONDecoder().decode(EnvironmentValueOrigin.self, from: Data(#""ci""#.utf8))
    }
}

@Test func environmentUpdateRequestLetsTheDaemonAssignRevisions() throws {
    let profile = try JSONDecoder().decode(ProjectEnvironment.self, from: Data(goServiceProfileJSON.utf8))
    let data = try JSONEncoder().encode(ProjectEnvironmentUpdateRequest(environment: profile, expectedRevision: 1))
    let fields = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let environment = try #require(fields["environment"] as? [String: Any])
    #expect(fields["expectedRevision"] as? Int == 1)
    #expect(environment["revision"] == nil)
    #expect((environment["tools"] as? [Any])?.count == 2)
}

@Test func projectsCarryEnvironmentsAndSurviveUnreadableOnes() throws {
    let project = try JSONDecoder().decode(Project.self, from: Data("""
    {"id":"p","name":"orders","path":"/repo","createdAt":1,"environment":\(goServiceProfileJSON)}
    """.utf8))
    #expect(project.environment?.services.first?.database == "orders")
    #expect(try JSONDecoder().decode(Project.self, from: JSONEncoder().encode(project)) == project)

    let future = try JSONDecoder().decode(Project.self, from: Data("""
    {"id":"p","name":"orders","path":"/repo","createdAt":1,"environment":{"revision":"two"}}
    """.utf8))
    #expect(future.environment == nil)
    #expect(future.name == "orders")
}

@Test func environmentPlanAndErrorDecode() throws {
    let plan = try JSONDecoder().decode(EnvironmentPlan.self, from: Data("""
    {"host":{"daemonId":"d","platform":"linux","arch":"x64"},"projectId":"p","profileRevision":1,
     "planHash":"h","computedAt":1,"items":[
       {"subject":"golangci-lint","required":"1.61.0","action":"install","installer":"mise",
        "commands":[["mise","install","golangci-lint@1.61.0"]],"approval":"plan","impact":{"network":["github.com"]}},
       {"subject":"postgres","required":"16","action":"manual","installer":"system",
        "commands":[["sudo","apt-get","install","postgresql-16"]],"approval":"user-runs","impact":{"network":[]}},
       {"subject":"go","required":"1.23.4","present":{"version":"1.23.4","path":"/x/go"},"action":"none",
        "installer":"go-tool","commands":[],"approval":"plan","impact":{"network":[]}}]}
    """.utf8))
    #expect(plan.items.map(\.action) == [.install, .manual, .none])
    #expect(plan.items[1].approval == .userRuns)
    #expect(plan.items[2].installer == .goTool)

    let readiness = try JSONDecoder().decode(EnvironmentReadiness.self, from: Data("""
    {"state":"not_ready","items":[{"id":"postgres","kind":"service","state":"not_ready","detail":"not running"}],
     "error":{"step":"Start Postgres 16","host":{"ref":{"daemonId":"d","platform":"linux","arch":"x64"},"name":"devbox-1"},
              "command":"pg_ctl start","outcome":"exit 1","output":"No space left on device","fix":"Free disk space.","at":1}}
    """.utf8))
    #expect(readiness.state == .notReady)
    #expect(readiness.error?.host.name == "devbox-1")
}

@Test func environmentCapabilityIsOptIn() throws {
    func hello(_ extra: String) throws -> DaemonHello {
        try JSONDecoder().decode(DaemonHello.self, from: Data("""
        {"daemonId":"d","daemonVersion":"1","protocolVersion":1,"minimumClientProtocolVersion":1,"platform":"linux",
         "arch":"x64","capabilities":{"powerManagement":false,"systemSleepEvents":false,"swiftUIArtifacts":false,
         "coordinatorIsolation":false,"independentExecution":true\(extra)}}
        """.utf8))
    }
    #expect(try !hello("").capabilities.supportsEnvironmentSetup)
    #expect(try hello(#","environmentSetup":1"#).capabilities.supportsEnvironmentSetup)
}

@Test func environmentOverridesAndLocalFilesRoundTrip() throws {
    let project = try JSONDecoder().decode(Project.self, from: Data("""
    {"id":"p","name":"orders","path":"/repo","createdAt":1,
     "environment":{"revision":2,"tools":[],"services":[],"steps":[],"confirmedSources":[],"copyFiles":[".env"]},
     "environmentOverride":{"revision":1,"env":{"GOFLAGS":"-p=2"},"remove":["golangci-lint"]}}
    """.utf8))
    #expect(project.environment?.copyFiles == [".env"])
    #expect(project.environmentOverride == ProjectEnvironmentOverride(revision: 1, remove: ["golangci-lint"], env: ["GOFLAGS": "-p=2"]))
    #expect(try JSONDecoder().decode(Project.self, from: JSONEncoder().encode(project)) == project)

    let data = try JSONEncoder().encode(ProjectEnvironmentOverrideUpdateRequest(
        override: ProjectEnvironmentOverride(revision: 9, env: ["A": "b"]), expectedRevision: 1))
    let fields = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect((fields["override"] as? [String: Any])?.keys.sorted() == ["env"], "no revision, no empty fields")
    let request = try JSONEncoder().encode(ProjectEnvironmentUpdateRequest(
        environment: ProjectEnvironment(copyFiles: [".env.local"]), expectedRevision: 0))
    #expect(String(decoding: request, as: UTF8.self).contains(#""copyFiles":[".env.local"]"#))
}

@Test func environmentToolCatalogAndDockerInstallerDecode() throws {
    let catalog = try JSONDecoder().decode(EnvironmentToolCatalog.self, from: Data(#"{"mise":true,"tools":["go","node"]}"#.utf8))
    #expect(catalog == EnvironmentToolCatalog(mise: true, tools: ["go", "node"]))
    let item = try JSONDecoder().decode(EnvironmentPlanItem.self, from: Data("""
    {"subject":"postgres","required":"16","action":"start","installer":"docker","commands":[],"approval":"plan",
     "impact":{"network":["docker.io"]}}
    """.utf8))
    #expect(item.installer == .docker)
}

@Test func environmentDiscoveryDecodesDaemonOutput() throws {
    let discovery = try JSONDecoder().decode(EnvironmentDiscovery.self, from: Data("""
    {"projectId":"p","computedAt":1,"truncated":false,"skipped":[{"path":"go.sum","reason":"too_large"}],"localFiles":[".env"],
     "sources":[{"path":"go.mod","sha256":"aa"}],
     "subjects":[
       {"subject":"go","category":"tool","status":"proposed","value":"1.23.4","from":{"path":"go.mod","line":5},
        "notes":[],"findings":[{"subject":"go","kind":"exact","value":"1.23.4",
          "source":{"path":"go.mod","line":5,"excerpt":"toolchain go1.23.4","sha256":"aa"}}]},
       {"subject":"golangci-lint","category":"tool","status":"conflict","notes":[],"goTool":true,"findings":[]},
       {"subject":"postgres","category":"service","status":"needs_version","notes":["x"],"findings":[]},
       {"subject":"python","category":"tool","status":"hint_only","notes":[],"findings":[]}],
     "steps":[{"id":"setup","title":"make setup","run":{"argv":["make","setup"]},"purpose":"setup","proposed":true,
               "source":{"path":"Makefile","line":4,"excerpt":"setup:","sha256":"bb"}}]}
    """.utf8))
    #expect(discovery.subjects.map(\.status) == [.proposed, .conflict, .needsVersion, .hintOnly])
    #expect(discovery.subjects[0].findings[0].source.citation == "go.mod:5")
    #expect(discovery.subjects[1].goTool == true)
    #expect(discovery.steps.first?.proposed == true)
    #expect(discovery.localFiles == [".env"])
    #expect(try JSONDecoder().decode(EnvironmentDiscovery.self, from: JSONEncoder().encode(discovery)) == discovery)
}
