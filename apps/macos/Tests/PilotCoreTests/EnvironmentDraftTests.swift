import Foundation
import Testing
@testable import PilotCore

private func source(_ path: String, _ line: Int, sha: String = "aa") -> EnvironmentFindingSource {
    EnvironmentFindingSource(path: path, line: line, excerpt: "", sha256: sha)
}

/// Discovery for the Go service worked example in docs/environment-setup.md.
private let goServiceDiscovery = EnvironmentDiscovery(
    projectId: "p",
    computedAt: 1,
    subjects: [
        EnvironmentSubject(subject: "go", category: .tool, status: .proposed, value: "1.23.4",
                           from: .init(path: "go.mod", line: 5), findings: [
                               EnvironmentFinding(subject: "go", kind: .minimum, value: "1.22.0", source: source("go.mod", 3)),
                               EnvironmentFinding(subject: "go", kind: .exact, value: "1.23.4", source: source("go.mod", 5)),
                               EnvironmentFinding(subject: "go", kind: .hint, value: "1.22+", source: source("README.md", 3)),
                           ]),
        EnvironmentSubject(subject: "golangci-lint", category: .tool, status: .conflict, findings: [
            EnvironmentFinding(subject: "golangci-lint", kind: .exact, value: "1.61.0", source: source(".tool-versions", 2)),
            EnvironmentFinding(subject: "golangci-lint", kind: .exact, value: "1.60.3", source: source("Makefile", 1)),
        ]),
        EnvironmentSubject(subject: "node", category: .tool, status: .needsVersion, findings: [
            EnvironmentFinding(subject: "node", kind: .minimum, value: "20", source: source("package.json", 5)),
        ]),
        EnvironmentSubject(subject: "python", category: .tool, status: .hintOnly, findings: [
            EnvironmentFinding(subject: "python", kind: .hint, value: "3.11", source: source("README.md", 7)),
        ]),
        EnvironmentSubject(subject: "postgres", category: .service, status: .proposed, value: "16",
                           from: .init(path: "compose.yaml", line: 3), findings: [
                               EnvironmentFinding(subject: "postgres", kind: .major, value: "16", source: source("compose.yaml", 3)),
                           ]),
    ],
    steps: [
        EnvironmentStepCandidate(id: "setup", title: "make setup", run: .init(argv: ["make", "setup"]), purpose: .setup,
                                 proposed: true, source: source("Makefile", 4)),
        EnvironmentStepCandidate(id: "migrate", title: "make migrate", run: .init(argv: ["make", "migrate"]),
                                 purpose: .setup, proposed: false, source: source("Makefile", 6)),
        EnvironmentStepCandidate(id: "lint", title: "make lint", run: .init(argv: ["make", "lint"]), purpose: .check,
                                 proposed: false, source: source("Makefile", 8)),
    ],
    sources: ["go.mod", ".tool-versions", "Makefile", "compose.yaml", "package.json", "README.md"]
        .map { EnvironmentSourcePin(path: $0, sha256: "h-\($0)") },
    localFiles: [".env", ".env.local"]
)

@Test func environmentDraftOffersDiscoveryWithoutChangingAnythingUntilChosen() {
    var draft = EnvironmentDraft(saved: nil, discovery: goServiceDiscovery)
    #expect(draft.tools.map(\.id) == ["go", "golangci-lint", "node"], "hint-only subjects are not rows")
    #expect(draft.tools.allSatisfy { !$0.included })
    #expect(draft.mentioned == ["Python 3.11 in README.md"])
    #expect(draft.tools[0].detail == "From go.mod:5")
    #expect(draft.tools[1].detail == "Files disagree: .tool-versions:2 says 1.61.0, Makefile:1 says 1.60.3. Pick one.")
    #expect(draft.tools[2].detail == "package.json:5 asks for >=20. Enter the exact version to use.")
    #expect(draft.steps.map(\.id) == ["setup", "migrate"], "checks are not setup steps")
    #expect(!draft.hasChanges)
    #expect(draft.hasSuggestions)

    draft.useSuggestions()
    #expect(draft.tools.map(\.included) == [true, false, false], "conflicts and missing versions wait for the user")
    #expect(draft.database.enabled)
    #expect(draft.database.version == "16")
    #expect(draft.steps.map(\.enabled) == [true, false])
    #expect(!draft.hasSuggestions)
    #expect(draft.hasChanges)

    draft.tools[1].included = true
    #expect(draft.undecided == ["golangci-lint"])
    draft.tools[1].choose("1.61.0")
    #expect(draft.tools[1].origin == .source(path: ".tool-versions", line: 2))
    #expect(draft.undecided.isEmpty)
    draft.tools[2].included = true
    draft.tools[2].choose("v20.11.1")

    let profile = draft.profile
    #expect(profile.revision == 0)
    #expect(profile.tools == [
        EnvironmentTool(id: "go", version: "1.23.4", from: .source(path: "go.mod", line: 5)),
        EnvironmentTool(id: "golangci-lint", version: "1.61.0", from: .source(path: ".tool-versions", line: 2)),
        EnvironmentTool(id: "node", version: "20.11.1", from: .user),
    ])
    #expect(profile.services == [EnvironmentService(id: "postgres", version: "16", provider: .pilot, exports: ["DATABASE_URL": .url])])
    #expect(profile.steps == [EnvironmentStep(id: "setup", title: "make setup", run: .argv(["make", "setup"]))])
    #expect(profile.confirmedSources.map(\.path) == ["go.mod", ".tool-versions", "Makefile", "compose.yaml", "package.json"],
            "README hints are not confirmed sources")
}

@Test func environmentDraftKeepsSavedFieldsAndOnlyReportsRealEdits() {
    let review = ReviewPin(files: [EnvironmentSourcePin(path: "Makefile", sha256: "x")], reviewedAt: 1)
    let saved = ProjectEnvironment(
        revision: 3,
        tools: [EnvironmentTool(id: "go", version: "1.23.4", from: .source(path: "go.mod", line: 5))],
        services: [EnvironmentService(id: "postgres", version: "16", provider: .pilot, database: "orders",
                                      dbTool: .access(read: .allow, write: .ask), exports: ["DATABASE_URL": .url])],
        steps: [EnvironmentStep(id: "setup", title: "Setup", run: .argv(["make", "setup"]), review: review,
                                inputs: ["go.sum"], requires: ["go", "postgres"])],
        env: ["GOFLAGS": "-mod=mod"],
        confirmedSources: [EnvironmentSourcePin(path: "go.mod", sha256: "old")])
    var draft = EnvironmentDraft(saved: saved, discovery: goServiceDiscovery)
    #expect(!draft.hasChanges, "refreshed hashes alone are not an edit")
    #expect(draft.tools.map(\.included) == [true, false, false])
    #expect(draft.profile.services == saved.services)
    #expect(draft.profile.steps == saved.steps, "review pins and inputs survive")
    #expect(draft.profile.env == saved.env)

    draft.tools[0].choose("1.24.0")
    #expect(draft.tools[0].origin == .user)
    draft.tools[0].choose("1.23.4")
    #expect(draft.tools[0].origin == .source(path: "go.mod", line: 5), "typing the saved value back restores its citation")
    #expect(!draft.hasChanges)

    draft.tools[0].included = false
    #expect(draft.profile.steps.first?.requires == ["postgres"], "steps never require removed tools")
    draft.database.enabled = false
    #expect(draft.profile.services.isEmpty)
    #expect(draft.profile.steps.first?.requires == [])

    let offline = EnvironmentDraft(saved: saved, discovery: nil)
    #expect(offline.profile.confirmedSources == saved.confirmedSources)
    #expect(offline.mentioned.isEmpty)
}

@Test func environmentVersionsAreExactAndNormalized() {
    #expect(EnvironmentNames.normalizedVersion("go1.23.4") == "1.23.4")
    #expect(EnvironmentNames.normalizedVersion(" v1.61.0 ") == "1.61.0")
    #expect(EnvironmentNames.normalizedVersion("latest") == nil)
    #expect(EnvironmentNames.normalizedVersion(">=20") == nil)
    #expect(EnvironmentNames.normalizedVersion("") == nil)
    #expect(EnvironmentNames.display("go") == "Go")
    #expect(EnvironmentNames.display("golangci-lint") == "golangci-lint")
}

@Test func environmentPlanLinesSayWhatEachItemNeedsAndOfflineSummariesDropDetails() {
    let items = [
        EnvironmentPlanItem(subject: "go", required: "1.23.4", present: .init(version: "1.23.4", path: "/Users/me/.local/share/mise/installs/go/1.23.4/bin/go"), action: .none),
        EnvironmentPlanItem(subject: "golangci-lint", required: "1.61.0", action: .install, installer: .mise,
                            commands: [["/m", "install", "golangci-lint@1.61.0"]], impact: .init(network: ["github.com"])),
        EnvironmentPlanItem(subject: "postgres", required: "16", action: .manual, installer: .system,
                            commands: [["sudo", "apt-get", "install", "-y", "postgresql-16"]], approval: .userRuns,
                            note: "Run this in a terminal on this host, then check again. Pilot never runs sudo."),
        EnvironmentPlanItem(subject: "step:setup", required: "Setup", action: .review, commands: [["make", "setup"]]),
        EnvironmentPlanItem(subject: "mise", required: "any", action: .install, installer: .homebrew,
                            commands: [["/opt/homebrew/bin/brew", "install", "mise"]], impact: .init(network: ["formulae.brew.sh"])),
    ]
    let lines = items.map { EnvironmentPlanLine($0, home: "/Users/me") }
    #expect(lines.map(\.title) == ["Go 1.23.4", "golangci-lint 1.61.0", "Postgres 16", "make setup", "mise"])
    #expect(lines.map(\.state) == ["Installed", "Missing", "Run yourself", "Needs review", "Missing"])
    #expect(lines.map(\.attention) == [false, true, true, true, true])
    #expect(lines[0].detail == "~/.local/share/mise/installs/go/1.23.4/bin/go")
    #expect(lines[1].detail == "Install with mise · github.com", "hosts are shown when the daemon knows them")
    #expect(lines[4].detail == "Install with Homebrew · formulae.brew.sh")
    #expect(lines[2].commands == ["sudo apt-get install -y postgresql-16"])
    #expect(lines[1].commands == nil, "commands Pilot would run are not shown as user commands")

    let plan = EnvironmentPlan(host: .init(daemonId: "d", platform: "linux", arch: "x64"), projectId: "p",
                               profileRevision: 1, planHash: "h", computedAt: 5, items: items)
    let known = EnvironmentLastKnown(plan: plan)
    #expect(known.checkedAt == 5)
    #expect(known.lines.allSatisfy { $0.detail == nil && $0.commands == nil })
    let encoded = String(decoding: try! JSONEncoder().encode(known), as: UTF8.self)
    #expect(!encoded.contains("sudo") && !encoded.contains("/Users/me"), "no commands or paths are kept offline")
}

@Test func environmentToolsComeFromMiseNames() {
    var draft = EnvironmentDraft(saved: nil, discovery: goServiceDiscovery)
    let added = [draft.addTool("terraform"), draft.addTool("aqua:owner/tool"), draft.addTool("Not a tool"),
                 draft.addTool(""), draft.addTool("go")]
    #expect(added == [true, true, false, false, true], "an existing row is switched on, not duplicated")
    #expect(draft.tools.map(\.id) == ["go", "golangci-lint", "node", "terraform", "aqua:owner/tool"])
    #expect(draft.tools[0].included && draft.tools[0].version == "1.23.4")
    #expect(draft.undecided == ["terraform", "aqua:owner/tool"])
    draft.tools[3].choose("1.9.5")
    #expect(draft.profile.tools.map(\.id) == ["go", "terraform"])
    #expect(draft.profile.tools[1].from == .user)

    let registry = ["go", "golangci-lint", "gofumpt", "terraform", "argo", "node"]
    #expect(EnvironmentNames.matches("go", in: registry) == ["go", "gofumpt", "golangci-lint", "argo"])
    #expect(EnvironmentNames.matches("  ", in: registry).isEmpty)
    #expect(EnvironmentNames.matches("o", in: registry, limit: 2).count == 2)

    let docker = EnvironmentPlanLine(EnvironmentPlanItem(
        subject: "postgres", required: "16", action: .start, installer: .docker, impact: .init(network: ["docker.io"]),
        note: "Start Pilot's Postgres 16 container."))
    #expect([docker.title, docker.state, docker.detail] == ["Postgres 16", "Not started", "Start Pilot's Postgres 16 container."])
}

@Test func environmentLocalFilesAreSuggestedAndSavedByPathOnly() {
    var draft = EnvironmentDraft(saved: nil, discovery: goServiceDiscovery)
    #expect(draft.copyFiles.isEmpty)
    #expect(draft.localFileSuggestions == [".env", ".env.local"])
    let added = [draft.addCopyFile(".env"), draft.addCopyFile(" config/dev.env "), draft.addCopyFile(".env"),
                 draft.addCopyFile("../secrets"), draft.addCopyFile(".git/config"), draft.addCopyFile("/etc/hosts"),
                 draft.addCopyFile("")]
    #expect(added == [true, true, true, false, false, false, false])
    #expect(draft.copyFiles == [".env", "config/dev.env"])
    #expect(draft.localFileSuggestions == [".env.local"])
    #expect(draft.hasChanges)
    #expect(draft.profile.copyFiles == [".env", "config/dev.env"])

    let saved = EnvironmentDraft(saved: ProjectEnvironment(revision: 2, copyFiles: [".env"]), discovery: goServiceDiscovery)
    #expect(saved.copyFiles == [".env"] && !saved.hasChanges)
    var cleared = saved
    cleared.copyFiles.removeAll()
    #expect(cleared.hasChanges && cleared.profile.copyFiles == nil)
    #expect(saved.database.detail.contains("its own database for each chat"))
}
