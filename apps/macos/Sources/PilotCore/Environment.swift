import Foundation

// Project environment setup. Mirrors packages/protocol/src/environment.ts; see docs/environment-setup.md.
// The profile is configuration saved on the Project. Plans, readiness and errors are per-host daemon state.

/// A file the profile was confirmed against. Paths are checkout-relative.
public struct EnvironmentSourcePin: Codable, Equatable, Hashable, Sendable {
    public let path: String
    public let sha256: String

    public init(path: String, sha256: String) {
        self.path = path
        self.sha256 = sha256
    }
}

/// Approved repository files. Only the user can write one, through the native host-action capability.
public struct ReviewPin: Codable, Equatable, Hashable, Sendable {
    public let files: [EnvironmentSourcePin]
    public let reviewedAt: Double

    public init(files: [EnvironmentSourcePin], reviewedAt: Double) {
        self.files = files
        self.reviewedAt = reviewedAt
    }
}

/// Where a confirmed value came from: a cited repository line (`{"path","line"}`) or the user (`"user"`).
public enum EnvironmentValueOrigin: Codable, Equatable, Hashable, Sendable {
    case user
    case source(path: String, line: Int)

    private struct Citation: Codable { let path: String; let line: Int }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) {
            guard value == "user" else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unknown origin \(value)")
            }
            self = .user
            return
        }
        let citation = try container.decode(Citation.self)
        self = .source(path: citation.path, line: citation.line)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .user: try container.encode("user")
        case let .source(path, line): try container.encode(Citation(path: path, line: line))
        }
    }
}

public struct EnvironmentTool: Codable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let version: String
    public let from: EnvironmentValueOrigin

    public init(id: String, version: String, from: EnvironmentValueOrigin) {
        self.id = id
        self.version = version
        self.from = from
    }
}

public enum EnvironmentExportValue: String, Codable, Hashable, Sendable, CaseIterable {
    case url, socketUrl, host, port, database, user
}

public enum EnvironmentDbAccess: String, Codable, Hashable, Sendable {
    case allow, ask
}

/// Agent db tool access to the built-in database. `false` on the wire hides it from the tool.
public enum EnvironmentDbTool: Codable, Equatable, Hashable, Sendable {
    case hidden
    case access(read: EnvironmentDbAccess, write: EnvironmentDbAccess)

    private struct Access: Codable { let read: EnvironmentDbAccess; let write: EnvironmentDbAccess }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let flag = try? container.decode(Bool.self) {
            guard !flag else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "dbTool true is not valid")
            }
            self = .hidden
            return
        }
        let access = try container.decode(Access.self)
        self = .access(read: access.read, write: access.write)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .hidden: try container.encode(false)
        case let .access(read, write): try container.encode(Access(read: read, write: write))
        }
    }
}

public struct EnvironmentCompose: Codable, Equatable, Hashable, Sendable {
    public let file: String
    public let service: String
    public let review: ReviewPin?

    public init(file: String, service: String, review: ReviewPin? = nil) {
        self.file = file
        self.service = service
        self.review = review
    }
}

public struct EnvironmentService: Codable, Equatable, Hashable, Sendable, Identifiable {
    public enum Provider: String, Codable, Hashable, Sendable { case pilot, compose }

    public let id: String
    /// Only "postgres" today.
    public let kind: String
    /// Major version, for example "16".
    public let version: String
    public let provider: Provider
    public let database: String?
    public let dbTool: EnvironmentDbTool?
    public let exports: [String: EnvironmentExportValue]
    public let compose: EnvironmentCompose?

    public init(
        id: String, kind: String = "postgres", version: String, provider: Provider, database: String? = nil,
        dbTool: EnvironmentDbTool? = nil, exports: [String: EnvironmentExportValue] = [:],
        compose: EnvironmentCompose? = nil
    ) {
        self.id = id
        self.kind = kind
        self.version = version
        self.provider = provider
        self.database = database
        self.dbTool = dbTool
        self.exports = exports
        self.compose = compose
    }
}

/// Never a shell string: an argv, or a checkout-relative script with arguments.
public enum EnvironmentStepRun: Codable, Equatable, Hashable, Sendable {
    case argv([String])
    case script(path: String, args: [String]?)

    private enum CodingKeys: String, CodingKey { case argv, script, args }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let argv = try container.decodeIfPresent([String].self, forKey: .argv) {
            self = .argv(argv)
            return
        }
        self = .script(
            path: try container.decode(String.self, forKey: .script),
            args: try container.decodeIfPresent([String].self, forKey: .args)
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .argv(argv): try container.encode(argv, forKey: .argv)
        case let .script(path, args):
            try container.encode(path, forKey: .script)
            try container.encodeIfPresent(args, forKey: .args)
        }
    }

    /// Display form, for example "make setup" or "scripts/bootstrap.sh --fast".
    public var displayCommand: String {
        switch self {
        case let .argv(argv): argv.joined(separator: " ")
        case let .script(path, args): ([path] + (args ?? [])).joined(separator: " ")
        }
    }
}

public struct EnvironmentStep: Codable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let run: EnvironmentStepRun
    public let review: ReviewPin?
    public let inputs: [String]
    public let check: [String]?
    public let requires: [String]
    public let timeoutMs: Int?

    public init(
        id: String, title: String, run: EnvironmentStepRun, review: ReviewPin? = nil, inputs: [String] = [],
        check: [String]? = nil, requires: [String] = [], timeoutMs: Int? = nil
    ) {
        self.id = id
        self.title = title
        self.run = run
        self.review = review
        self.inputs = inputs
        self.check = check
        self.requires = requires
        self.timeoutMs = timeoutMs
    }
}

/// Saved on the Project. The daemon assigns revision; edits send the revision they started from.
public struct ProjectEnvironment: Codable, Equatable, Hashable, Sendable {
    public let revision: Int
    public let tools: [EnvironmentTool]
    public let services: [EnvironmentService]
    public let steps: [EnvironmentStep]
    public let env: [String: String]?
    public let confirmedSources: [EnvironmentSourcePin]
    /// Ignored local files (such as .env) copied into each workspace. Paths only; contents are never stored.
    public let copyFiles: [String]?

    public init(
        revision: Int = 0, tools: [EnvironmentTool] = [], services: [EnvironmentService] = [],
        steps: [EnvironmentStep] = [], env: [String: String]? = nil, confirmedSources: [EnvironmentSourcePin] = [],
        copyFiles: [String]? = nil
    ) {
        self.revision = revision
        self.tools = tools
        self.services = services
        self.steps = steps
        self.env = env
        self.confirmedSources = confirmedSources
        self.copyFiles = copyFiles
    }

    public var isEmpty: Bool {
        tools.isEmpty && services.isEmpty && steps.isEmpty && (env ?? [:]).isEmpty && (copyFiles ?? []).isEmpty
    }
}

/// One host's layer over the shared profile, never synced. It wins on its host: entries replace shared ones with the
/// same ID, remove drops shared IDs, env merges by key and copyFiles adds paths.
public struct ProjectEnvironmentOverride: Codable, Equatable, Hashable, Sendable {
    public let revision: Int
    public let tools: [EnvironmentTool]?
    public let services: [EnvironmentService]?
    public let steps: [EnvironmentStep]?
    public let remove: [String]?
    public let env: [String: String]?
    public let copyFiles: [String]?

    public init(
        revision: Int = 0, tools: [EnvironmentTool]? = nil, services: [EnvironmentService]? = nil,
        steps: [EnvironmentStep]? = nil, remove: [String]? = nil, env: [String: String]? = nil,
        copyFiles: [String]? = nil
    ) {
        self.revision = revision
        self.tools = tools
        self.services = services
        self.steps = steps
        self.remove = remove
        self.env = env
        self.copyFiles = copyFiles
    }
}

/// PUT /api/projects/:id/environment/override. The layer is sent without its revision; {} clears it.
public struct ProjectEnvironmentOverrideUpdateRequest: Encodable, Equatable, Sendable {
    public let override: ProjectEnvironmentOverride
    public let expectedRevision: Int

    public init(override: ProjectEnvironmentOverride, expectedRevision: Int) {
        self.override = override
        self.expectedRevision = expectedRevision
    }

    private enum CodingKeys: String, CodingKey { case override, expectedRevision }
    private enum LayerKeys: String, CodingKey { case tools, services, steps, remove, env, copyFiles }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(expectedRevision, forKey: .expectedRevision)
        var layer = container.nestedContainer(keyedBy: LayerKeys.self, forKey: .override)
        try layer.encodeIfPresent(override.tools, forKey: .tools)
        try layer.encodeIfPresent(override.services, forKey: .services)
        try layer.encodeIfPresent(override.steps, forKey: .steps)
        try layer.encodeIfPresent(override.remove, forKey: .remove)
        try layer.encodeIfPresent(override.env, forKey: .env)
        try layer.encodeIfPresent(override.copyFiles, forKey: .copyFiles)
    }
}

/// PUT /api/projects/:id/environment. expectedRevision is 0 when the project has no profile.
public struct ProjectEnvironmentUpdateRequest: Encodable, Equatable, Sendable {
    public let environment: ProjectEnvironment
    public let expectedRevision: Int

    public init(environment: ProjectEnvironment, expectedRevision: Int) {
        self.environment = environment
        self.expectedRevision = expectedRevision
    }

    private enum CodingKeys: String, CodingKey { case environment, expectedRevision }
    private enum ProfileKeys: String, CodingKey { case tools, services, steps, env, confirmedSources, copyFiles }

    /// The daemon assigns revisions, so the profile is sent without one.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(expectedRevision, forKey: .expectedRevision)
        var profile = container.nestedContainer(keyedBy: ProfileKeys.self, forKey: .environment)
        try profile.encode(environment.tools, forKey: .tools)
        try profile.encode(environment.services, forKey: .services)
        try profile.encode(environment.steps, forKey: .steps)
        try profile.encodeIfPresent(environment.env, forKey: .env)
        try profile.encode(environment.confirmedSources, forKey: .confirmedSources)
        try profile.encodeIfPresent(environment.copyFiles, forKey: .copyFiles)
    }
}

/// Where a finding was read. excerpt is at most 120 characters of the cited line.
public struct EnvironmentFindingSource: Codable, Equatable, Hashable, Sendable {
    public let path: String
    public let line: Int
    public let excerpt: String
    public let sha256: String

    public init(path: String, line: Int, excerpt: String, sha256: String) {
        self.path = path
        self.line = line
        self.excerpt = excerpt
        self.sha256 = sha256
    }

    /// "go.mod:5".
    public var citation: String { "\(path):\(line)" }
}

public enum EnvironmentFindingKind: String, Codable, Hashable, Sendable {
    case exact, minimum, range, major, hint, unknown
}

/// One declaration read from a repository file. Discovery never executes anything.
public struct EnvironmentFinding: Codable, Equatable, Hashable, Sendable {
    public let subject: String
    public let kind: EnvironmentFindingKind
    public let value: String?
    public let source: EnvironmentFindingSource
    public let note: String?

    public init(
        subject: String, kind: EnvironmentFindingKind, value: String? = nil, source: EnvironmentFindingSource,
        note: String? = nil
    ) {
        self.subject = subject
        self.kind = kind
        self.value = value
        self.source = source
        self.note = note
    }
}

public enum EnvironmentSubjectStatus: String, Codable, Hashable, Sendable {
    case proposed, conflict, needsVersion = "needs_version", hintOnly = "hint_only"
}

public struct EnvironmentSubject: Codable, Equatable, Hashable, Sendable, Identifiable {
    public enum Category: String, Codable, Hashable, Sendable { case tool, service }
    public struct Citation: Codable, Equatable, Hashable, Sendable {
        public let path: String
        public let line: Int
        public init(path: String, line: Int) {
            self.path = path
            self.line = line
        }
    }

    public let subject: String
    public let category: Category
    public let status: EnvironmentSubjectStatus
    public let value: String?
    public let from: Citation?
    public let findings: [EnvironmentFinding]
    public let notes: [String]
    public let goTool: Bool?

    public var id: String { subject }

    public init(
        subject: String, category: Category, status: EnvironmentSubjectStatus, value: String? = nil,
        from: Citation? = nil, findings: [EnvironmentFinding] = [], notes: [String] = [], goTool: Bool? = nil
    ) {
        self.subject = subject
        self.category = category
        self.status = status
        self.value = value
        self.from = from
        self.findings = findings
        self.notes = notes
        self.goTool = goTool
    }
}

/// A setup step or post-run check proposed from a Makefile or justfile target. Never run by discovery.
public struct EnvironmentStepCandidate: Codable, Equatable, Hashable, Sendable, Identifiable {
    public enum Purpose: String, Codable, Hashable, Sendable { case setup, check }
    public struct Run: Codable, Equatable, Hashable, Sendable {
        public let argv: [String]
        public init(argv: [String]) { self.argv = argv }
    }

    public let id: String
    public let title: String
    public let run: Run
    public let purpose: Purpose
    public let proposed: Bool
    public let source: EnvironmentFindingSource

    public init(id: String, title: String, run: Run, purpose: Purpose, proposed: Bool, source: EnvironmentFindingSource) {
        self.id = id
        self.title = title
        self.run = run
        self.purpose = purpose
        self.proposed = proposed
        self.source = source
    }
}

/// GET /api/projects/:id/environment/discovery. Read-only and bounded on the project's host.
public struct EnvironmentDiscovery: Codable, Equatable, Hashable, Sendable {
    public struct Skipped: Codable, Equatable, Hashable, Sendable {
        public let path: String
        /// too_large, not_regular, limit or unreadable.
        public let reason: String
        public init(path: String, reason: String) {
            self.path = path
            self.reason = reason
        }
    }

    public let projectId: String
    public let computedAt: Double
    public let subjects: [EnvironmentSubject]
    public let steps: [EnvironmentStepCandidate]
    public let sources: [EnvironmentSourcePin]
    public let skipped: [Skipped]
    public let truncated: Bool
    /// Root .env files Git ignores, by name only: suggestions for copyFiles.
    public let localFiles: [String]?

    public init(
        projectId: String, computedAt: Double, subjects: [EnvironmentSubject] = [],
        steps: [EnvironmentStepCandidate] = [], sources: [EnvironmentSourcePin] = [], skipped: [Skipped] = [],
        truncated: Bool = false, localFiles: [String]? = nil
    ) {
        self.projectId = projectId
        self.computedAt = computedAt
        self.subjects = subjects
        self.steps = steps
        self.sources = sources
        self.skipped = skipped
        self.truncated = truncated
        self.localFiles = localFiles
    }
}

/// The daemon that computed a plan or raised an error. Clients add the host name they know.
public struct EnvironmentHostRef: Codable, Equatable, Hashable, Sendable {
    public let daemonId: String
    public let lineageId: String?
    public let platform: String
    public let arch: String

    public init(daemonId: String, lineageId: String? = nil, platform: String, arch: String) {
        self.daemonId = daemonId
        self.lineageId = lineageId
        self.platform = platform
        self.arch = arch
    }
}

public struct EnvironmentPlanItem: Codable, Equatable, Hashable, Sendable {
    public enum Action: String, Codable, Hashable, Sendable { case none, install, start, review, run, manual }
    public enum Installer: String, Codable, Hashable, Sendable {
        case mise, goTool = "go-tool", homebrew, docker, system, compose, pilot
    }
    public enum Approval: String, Codable, Hashable, Sendable { case plan, userRuns = "user-runs" }
    public struct Present: Codable, Equatable, Hashable, Sendable {
        public let version: String
        public let path: String
        public init(version: String, path: String) {
            self.version = version
            self.path = path
        }
    }
    public struct Impact: Codable, Equatable, Hashable, Sendable {
        public let network: [String]
        public let downloadBytes: Int?
        public let diskBytes: Int?
        public init(network: [String] = [], downloadBytes: Int? = nil, diskBytes: Int? = nil) {
            self.network = network
            self.downloadBytes = downloadBytes
            self.diskBytes = diskBytes
        }
    }

    public let subject: String
    public let required: String
    public let present: Present?
    public let action: Action
    public let installer: Installer?
    public let commands: [[String]]
    public let approval: Approval
    public let impact: Impact
    public let note: String?

    public init(
        subject: String, required: String, present: Present? = nil, action: Action, installer: Installer? = nil,
        commands: [[String]] = [], approval: Approval = .plan, impact: Impact = Impact(), note: String? = nil
    ) {
        self.subject = subject
        self.required = required
        self.present = present
        self.action = action
        self.installer = installer
        self.commands = commands
        self.approval = approval
        self.impact = impact
        self.note = note
    }
}

/// GET /api/projects/:id/environment/plan. A preview computed by the host's daemon; it changes nothing.
public struct EnvironmentPlan: Codable, Equatable, Hashable, Sendable {
    public let host: EnvironmentHostRef
    public let projectId: String
    /// Shared profile revision.
    public let profileRevision: Int
    /// This host's override revision, 0 without one. Optional for plans kept before overrides existed.
    public let overrideRevision: Int?
    public let planHash: String
    public let computedAt: Double
    public let items: [EnvironmentPlanItem]

    public init(
        host: EnvironmentHostRef, projectId: String, profileRevision: Int, overrideRevision: Int? = 0,
        planHash: String, computedAt: Double, items: [EnvironmentPlanItem]
    ) {
        self.host = host
        self.projectId = projectId
        self.profileRevision = profileRevision
        self.overrideRevision = overrideRevision
        self.planHash = planHash
        self.computedAt = computedAt
        self.items = items
    }
}

public enum EnvironmentReadinessState: String, Codable, Hashable, Sendable {
    case ready, settingUp = "setting_up", notReady = "not_ready", unknown
}

public struct EnvironmentItemReadiness: Codable, Equatable, Hashable, Sendable {
    public enum Kind: String, Codable, Hashable, Sendable { case tool, service, step }
    public enum State: String, Codable, Hashable, Sendable { case ready, notReady = "not_ready", unknown }

    public let id: String
    public let kind: Kind
    public let state: State
    public let version: String?
    public let checkedAt: Double?
    public let detail: String?

    public init(
        id: String, kind: Kind, state: State, version: String? = nil, checkedAt: Double? = nil, detail: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.state = state
        self.version = version
        self.checkedAt = checkedAt
        self.detail = detail
    }
}

/// Unknown is never shown as ready.
public struct EnvironmentReadiness: Codable, Equatable, Hashable, Sendable {
    public let state: EnvironmentReadinessState
    public let outdated: Bool?
    public let checkedAt: Double?
    public let items: [EnvironmentItemReadiness]
    public let error: EnvironmentError?

    public init(
        state: EnvironmentReadinessState, outdated: Bool? = nil, checkedAt: Double? = nil,
        items: [EnvironmentItemReadiness] = [], error: EnvironmentError? = nil
    ) {
        self.state = state
        self.outdated = outdated
        self.checkedAt = checkedAt
        self.items = items
        self.error = error
    }
}

/// Offline host index entry: no commands, paths or output.
public struct EnvironmentReadinessSummary: Codable, Equatable, Hashable, Sendable {
    public struct Item: Codable, Equatable, Hashable, Sendable {
        public let id: String
        public let version: String?
        public let state: EnvironmentItemReadiness.State
        public init(id: String, version: String? = nil, state: EnvironmentItemReadiness.State) {
            self.id = id
            self.version = version
            self.state = state
        }
    }

    public let projectId: String
    public let state: EnvironmentReadinessState
    public let checkedAt: Double?
    public let items: [Item]

    public init(projectId: String, state: EnvironmentReadinessState, checkedAt: Double? = nil, items: [Item] = []) {
        self.projectId = projectId
        self.state = state
        self.checkedAt = checkedAt
        self.items = items
    }
}

public struct EnvironmentError: Codable, Equatable, Hashable, Sendable {
    public struct Host: Codable, Equatable, Hashable, Sendable {
        public let ref: EnvironmentHostRef
        public let name: String
        public init(ref: EnvironmentHostRef, name: String) {
            self.ref = ref
            self.name = name
        }
    }

    public let step: String
    public let host: Host
    public let command: String
    public let outcome: String
    public let output: String
    public let fix: String
    public let at: Double

    public init(step: String, host: Host, command: String, outcome: String, output: String, fix: String, at: Double) {
        self.step = step
        self.host = host
        self.command = command
        self.outcome = outcome
        self.output = output
        self.fix = fix
        self.at = at
    }
}
