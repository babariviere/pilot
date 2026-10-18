import Foundation

// Editing an environment profile from discovery findings, and presenting a host's plan. Pure values for the
// Environment section in project settings; see docs/environment-setup.md.

/// Display names for normalized subjects.
public enum EnvironmentNames {
    public static func display(_ subject: String) -> String {
        switch subject {
        case "go": "Go"
        case "node": "Node"
        case "python": "Python"
        case "postgres": "Postgres"
        case "ruby": "Ruby"
        case "rust": "Rust"
        default: subject
        }
    }

    /// A mise registry name ("go", "golangci-lint") or a backend reference ("aqua:owner/repo"), as the daemon accepts.
    public static func isToolName(_ value: String) -> Bool {
        guard let first = value.first, value.count <= 64, first.isLowercase || first.isNumber else { return false }
        return value.allSatisfy { ($0.isLowercase || $0.isNumber || "._@:/-".contains($0)) && $0.isASCII }
    }

    /// Mise registry names matching a query: prefix matches first, then other matches, at most limit.
    public static func matches(_ query: String, in names: [String], limit: Int = 8) -> [String] {
        let query = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !query.isEmpty else { return [] }
        let prefix = names.filter { $0.hasPrefix(query) }
        let other = names.filter { !$0.hasPrefix(query) && $0.contains(query) }
        return Array((prefix.sorted { $0.count < $1.count || ($0.count == $1.count && $0 < $1) } + other).prefix(limit))
    }

    /// Exact versions start with a digit: "1.23.4", "v1.61.0" (normalized), never ranges or aliases.
    public static func normalizedVersion(_ raw: String) -> String? {
        var value = raw.trimmingCharacters(in: .whitespaces)
        for prefix in ["go", "v"] where value.hasPrefix(prefix) && value.dropFirst(prefix.count).first?.isNumber == true {
            value.removeFirst(prefix.count)
        }
        guard let first = value.first, first.isNumber, value.count <= 64,
              value.allSatisfy({ $0.isLetter || $0.isNumber || ".+_-".contains($0) }) else { return nil }
        return value
    }
}

public struct EnvironmentDraft: Equatable, Sendable {
    /// A version a repository file declares, offered when files disagree.
    public struct Option: Equatable, Hashable, Sendable {
        public let value: String
        public let origin: EnvironmentValueOrigin
        public let citation: String
    }

    public struct ToolRow: Equatable, Identifiable, Sendable {
        public let id: String
        public var included: Bool
        /// The chosen exact version; empty until the user picks or enters one.
        public var version: String
        public var origin: EnvironmentValueOrigin
        /// Discovery status, nil for a tool only the saved profile has.
        public let status: EnvironmentSubjectStatus?
        public let options: [Option]
        public let detail: String
        /// The saved or proposed value, restored with its citation when the user types it back.
        let savedVersion: String?
        let savedOrigin: EnvironmentValueOrigin?

        public var title: String { EnvironmentNames.display(id) }
        public var hasVersion: Bool { EnvironmentNames.normalizedVersion(version) != nil }

        /// Pick a declared version (keeping its citation) or enter one (from the user).
        public mutating func choose(_ value: String) {
            guard value != version else { return }
            if let savedVersion, let savedOrigin, value == savedVersion {
                version = value
                origin = savedOrigin
            } else if let option = options.first(where: { $0.value == value }) {
                version = option.value
                origin = option.origin
            } else {
                version = value
                origin = .user
            }
        }
    }

    /// Pilot's built-in Postgres for this project.
    public struct Database: Equatable, Sendable {
        public var enabled: Bool
        public var version: String
        public let detail: String
        public let options: [String]
        let saved: EnvironmentService?
    }

    public struct StepRow: Equatable, Identifiable, Sendable {
        public let id: String
        public let title: String
        public var enabled: Bool
        public let detail: String
        let step: EnvironmentStep
    }

    public var tools: [ToolRow]
    public var database: Database
    public var steps: [StepRow]
    /// Ignored local files (such as .env) copied from the main checkout into each workspace. Paths only.
    public var copyFiles: [String]
    /// Subjects only README or CI files mention, for example "Python 3.11 in README.md".
    public let mentioned: [String]
    let saved: ProjectEnvironment?
    let discovery: EnvironmentDiscovery?

    /// Rows a confirmed profile has, plus discovery proposals the user has not taken yet (off until chosen).
    public init(saved: ProjectEnvironment?, discovery: EnvironmentDiscovery?) {
        self.saved = saved
        self.discovery = discovery
        let subjects = Dictionary((discovery?.subjects ?? []).map { ($0.subject, $0) }, uniquingKeysWith: { first, _ in first })
        var tools: [ToolRow] = []
        for tool in saved?.tools ?? [] {
            let subject = subjects[tool.id]
            tools.append(ToolRow(
                id: tool.id, included: true, version: tool.version, origin: tool.from, status: subject?.status,
                options: Self.options(subject), detail: Self.savedDetail(tool, subject: subject),
                savedVersion: tool.version, savedOrigin: tool.from))
        }
        for subject in discovery?.subjects ?? [] where subject.category == .tool && subject.status != .hintOnly
            && !tools.contains(where: { $0.id == subject.subject }) {
            let origin: EnvironmentValueOrigin = subject.from.map { .source(path: $0.path, line: $0.line) } ?? .user
            tools.append(ToolRow(
                id: subject.subject, included: false, version: subject.value ?? "", origin: origin,
                status: subject.status, options: Self.options(subject), detail: Self.discoveryDetail(subject),
                savedVersion: subject.value, savedOrigin: origin))
        }
        self.tools = tools

        let savedDatabase = saved?.services.first { $0.provider == .pilot }
        let discovered = subjects["postgres"]
        let majors = Set(["14", "15", "16", "17"] + Self.options(discovered).map(\.value) + [savedDatabase?.version].compactMap { $0 })
        database = Database(
            enabled: savedDatabase != nil,
            version: savedDatabase?.version ?? discovered?.value ?? Self.options(discovered).first?.value ?? "17",
            detail: savedDatabase == nil && discovered.map { [.proposed, .conflict].contains($0.status) } == true
                ? Self.databaseDetail(discovered!) : "Pilot's built-in Postgres, with its own database for each chat.",
            options: majors.sorted { (Int($0) ?? 0) > (Int($1) ?? 0) },
            saved: savedDatabase)

        var steps = (saved?.steps ?? []).map { step in
            StepRow(id: step.id, title: step.run.displayCommand, enabled: true,
                    detail: step.review == nil ? "Runs in new and restored workspaces once you review it."
                        : "Reviewed. Runs in new and restored workspaces.",
                    step: step)
        }
        for candidate in discovery?.steps ?? [] where candidate.purpose == .setup && !steps.contains(where: { $0.id == candidate.id }) {
            steps.append(StepRow(
                id: candidate.id, title: candidate.title, enabled: false,
                detail: "From \(candidate.source.citation). Runs in new and restored workspaces once you review it.",
                step: EnvironmentStep(id: candidate.id, title: candidate.title, run: .argv(candidate.run.argv))))
        }
        self.steps = steps
        copyFiles = saved?.copyFiles ?? []
        mentioned = (discovery?.subjects ?? []).filter { $0.status == .hintOnly }.compactMap { subject in
            guard let finding = subject.findings.first else { return nil }
            let place = finding.source.path.hasPrefix(".github/") ? "CI" : finding.source.path
            return "\(EnvironmentNames.display(subject.subject))\(finding.value.map { " \($0)" } ?? "") in \(place)"
        }
    }

    /// Discovery proposals not taken yet: proposed tools, the proposed database and the proposed setup step.
    public var hasSuggestions: Bool {
        tools.contains { !$0.included && $0.status == .proposed }
            || (!database.enabled && database.saved == nil && discovery?.subjects.contains { $0.subject == "postgres" && $0.status == .proposed } == true)
            || steps.contains { !$0.enabled && $0.step.review == nil && proposedStep == $0.id }
    }

    private var proposedStep: String? { discovery?.steps.first { $0.proposed }?.id }

    /// Turn on every unambiguous proposal. Conflicts and missing versions stay for the user to decide.
    public mutating func useSuggestions() {
        for index in tools.indices where !tools[index].included && tools[index].status == .proposed {
            tools[index].included = true
        }
        if discovery?.subjects.contains(where: { $0.subject == "postgres" && $0.status == .proposed }) == true {
            database.enabled = true
        }
        if let proposedStep, let index = steps.firstIndex(where: { $0.id == proposedStep }) { steps[index].enabled = true }
    }

    /// Add a tool by its mise name (from the host's registry, or a backend such as aqua:owner/repo), switched on and
    /// waiting for a version. An existing row is switched on instead of duplicated.
    @discardableResult
    public mutating func addTool(_ name: String) -> Bool {
        let id = name.trimmingCharacters(in: .whitespaces)
        guard EnvironmentNames.isToolName(id) else { return false }
        if let index = tools.firstIndex(where: { $0.id == id }) {
            tools[index].included = true
            return true
        }
        tools.append(ToolRow(id: id, included: true, version: "", origin: .user, status: nil, options: [],
                             detail: "Added by you from mise's registry.", savedVersion: nil, savedOrigin: nil))
        return true
    }

    /// Ignored root files discovery found that the profile doesn't copy yet.
    public var localFileSuggestions: [String] {
        (discovery?.localFiles ?? []).filter { !copyFiles.contains($0) }
    }

    /// Add a local file to copy: a checkout-relative path outside .git and .jj, at most 32 files.
    @discardableResult
    public mutating func addCopyFile(_ raw: String) -> Bool {
        let path = raw.trimmingCharacters(in: .whitespaces)
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard !path.isEmpty, !path.hasPrefix("/"), !path.contains("\\"), path.utf8.count <= 512,
              parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && $0 != ".git" && $0 != ".jj" }),
              copyFiles.count < 32 else { return false }
        if !copyFiles.contains(path) { copyFiles.append(path) }
        return true
    }

    /// Tools turned on without a usable version. They are left out when saving, without blocking the rest.
    public var undecided: [String] { tools.filter { $0.included && !$0.hasVersion }.map(\.title) }

    /// The profile to save. Unchanged rows keep their saved fields, including review pins.
    public var profile: ProjectEnvironment {
        let tools = tools.compactMap { row -> EnvironmentTool? in
            guard row.included, let version = EnvironmentNames.normalizedVersion(row.version) else { return nil }
            return EnvironmentTool(id: row.id, version: version, from: row.origin)
        }
        var services = (saved?.services ?? []).filter { $0.provider != .pilot }
        if database.enabled {
            let base = database.saved
            services.insert(EnvironmentService(
                id: base?.id ?? "postgres", version: database.version, provider: .pilot, database: base?.database,
                dbTool: base?.dbTool, exports: base?.exports ?? ["DATABASE_URL": .url]), at: 0)
        }
        let steps = steps.filter(\.enabled).map(\.step).map { step in
            // A step can only require what the profile still has.
            let known = Set(tools.map(\.id) + services.map(\.id))
            return EnvironmentStep(id: step.id, title: step.title, run: step.run, review: step.review, inputs: step.inputs,
                                   check: step.check, requires: step.requires.filter(known.contains), timeoutMs: step.timeoutMs)
        }
        return ProjectEnvironment(revision: saved?.revision ?? 0, tools: tools, services: services, steps: steps,
                                  env: saved?.env, confirmedSources: confirmedSources(tools: tools, steps: steps),
                                  copyFiles: copyFiles.isEmpty ? nil : copyFiles)
    }

    /// Files cited by what the profile keeps, so later drift is a change to a file the user confirmed against.
    private func confirmedSources(tools: [EnvironmentTool], steps: [EnvironmentStep]) -> [EnvironmentSourcePin] {
        guard let discovery else { return saved?.confirmedSources ?? [] }
        var paths = Set<String>()
        let kept = Set(tools.map(\.id) + (database.enabled ? ["postgres"] : []))
        for subject in discovery.subjects where kept.contains(subject.subject) {
            for finding in subject.findings where finding.kind != .hint { paths.insert(finding.source.path) }
        }
        for candidate in discovery.steps where steps.contains(where: { $0.id == candidate.id }) {
            paths.insert(candidate.source.path)
        }
        return discovery.sources.filter { paths.contains($0.path) }
    }

    /// Whether saving would change the saved profile. Refreshed source hashes alone are not an edit.
    public var hasChanges: Bool {
        let current = profile
        let base = saved ?? ProjectEnvironment()
        return current.tools != base.tools || current.services != base.services || current.steps != base.steps
            || (current.env ?? [:]) != (base.env ?? [:]) || (current.copyFiles ?? []) != (base.copyFiles ?? [])
    }

    private static func options(_ subject: EnvironmentSubject?) -> [Option] {
        guard let subject else { return [] }
        var seen = Set<String>()
        return subject.findings.compactMap { finding in
            guard [.exact, .major].contains(finding.kind), let value = finding.value, seen.insert(value).inserted else { return nil }
            return Option(value: value, origin: .source(path: finding.source.path, line: finding.source.line),
                          citation: finding.source.citation)
        }
    }

    private static func discoveryDetail(_ subject: EnvironmentSubject) -> String {
        switch subject.status {
        case .proposed:
            let from = subject.from.map { "From \($0.path):\($0.line)" } ?? "Found in the repository"
            return ([from] + subject.notes).joined(separator: " · ")
        case .conflict:
            let options = options(subject).map { "\($0.citation) says \($0.value)" }
            return "Files disagree: \(options.joined(separator: ", ")). Pick one."
        case .needsVersion, .hintOnly:
            let constraints = subject.findings.filter { [.minimum, .range].contains($0.kind) }
                .map { "\($0.source.citation) asks for \($0.kind == .minimum ? ">=" : "")\($0.value ?? "")" }
            let lead = constraints.isEmpty ? "No exact version found" : constraints.joined(separator: ", ")
            return "\(lead). Enter the exact version to use."
        }
    }

    private static func savedDetail(_ tool: EnvironmentTool, subject: EnvironmentSubject?) -> String {
        let from: String
        switch tool.from {
        case .user: from = "Entered by you"
        case let .source(path, line): from = "From \(path):\(line)"
        }
        guard let subject, subject.status == .proposed, let value = subject.value, value != tool.version,
              let citation = subject.from else { return from }
        return "\(from) · \(citation.path):\(citation.line) now says \(value)"
    }

    private static func databaseDetail(_ subject: EnvironmentSubject) -> String {
        let base = "Pilot's built-in Postgres, with its own database for each chat."
        if subject.status == .conflict {
            return "\(base) Files disagree: \(options(subject).map { "\($0.citation) says \($0.value)" }.joined(separator: ", "))."
        }
        return subject.from.map { "\(base) From \($0.path):\($0.line)." } ?? base
    }
}

/// One plan line, shown live with commands and paths, or as an offline last-known summary without them.
public struct EnvironmentPlanLine: Codable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let state: String
    /// The user can act on it (install, review, run a command).
    public let attention: Bool
    public let detail: String?
    /// Commands the user runs themselves (sudo). Never kept for offline display.
    public let commands: [String]?

    public init(id: String, title: String, state: String, attention: Bool, detail: String? = nil, commands: [String]? = nil) {
        self.id = id
        self.title = title
        self.state = state
        self.attention = attention
        self.detail = detail
        self.commands = commands
    }

    public init(_ item: EnvironmentPlanItem, home: String? = nil) {
        let name = item.subject.hasPrefix("step:")
            ? (item.commands.first?.joined(separator: " ") ?? item.required)
            : item.subject == "mise" ? "mise" : "\(EnvironmentNames.display(item.subject)) \(item.required)"
        let network = item.impact.network.isEmpty ? "" : " · \(item.impact.network.joined(separator: ", "))"
        let state: String
        var attention = true
        var detail = item.note
        var commands: [String]?
        switch item.action {
        case .none:
            state = item.installer == .goTool ? "Via go tool" : "Installed"
            attention = false
            if let present = item.present { detail = Self.abbreviate(present.path, home: home) }
        case .install:
            state = "Missing"
            let installer = item.installer == .homebrew ? "Homebrew" : item.installer?.rawValue ?? "Pilot"
            detail = "Install with \(installer)\(network)" + (item.present.map { " · \($0.version) is installed" } ?? "")
        case .start:
            state = "Not started"
            attention = false
        case .review:
            state = "Needs review"
        case .run:
            state = "Reviewed"
            attention = false
        case .manual:
            state = item.commands.isEmpty ? "Missing" : "Run yourself"
            if item.approval == .userRuns, !item.commands.isEmpty { commands = item.commands.map { $0.joined(separator: " ") } }
        }
        self.init(id: item.subject, title: name, state: state, attention: attention, detail: detail, commands: commands)
    }

    /// The offline summary keeps only titles and states: no commands, paths or output.
    public var summary: EnvironmentPlanLine {
        EnvironmentPlanLine(id: id, title: title, state: state, attention: attention)
    }

    private static func abbreviate(_ path: String, home: String?) -> String {
        guard let home, !home.isEmpty, path.hasPrefix(home + "/") else { return path }
        return "~" + path.dropFirst(home.count)
    }
}

/// The last plan a host returned, kept by the app for offline display.
public struct EnvironmentLastKnown: Codable, Equatable, Sendable {
    public let checkedAt: Double
    public let lines: [EnvironmentPlanLine]

    public init(plan: EnvironmentPlan) {
        checkedAt = plan.computedAt
        lines = plan.items.map { EnvironmentPlanLine($0).summary }
    }

    public init(checkedAt: Double, lines: [EnvironmentPlanLine]) {
        self.checkedAt = checkedAt
        self.lines = lines
    }
}
