import Foundation

/// User-facing one-line events for automatic input and question records. The sentence says what happened; the
/// full text the agent received stays behind Show as the detail.
extension ChatEvent {
    /// Automatic input delivered to the chat: background job results, coordinator messages, PR follow-ups and
    /// extension messages. Mission notices keep their own summary.
    public static func automatic(id: String, text: String, origin: InputOrigin, timestamp: Double? = nil) -> ChatEvent {
        if let notification = SubagentNotification(message: text) {
            return subagent(id: id, notification: notification, timestamp: timestamp)
        }
        var event: ChatEvent
        switch origin {
        case .job:
            let summary = JobResultSummary(text: text)
            event = ChatEvent(id: id, kind: summary.failed ? "job_failed" : "job_finished", text: summary.sentence,
                              title: summary.jobs.isEmpty ? preview(text) : summary.title, destructive: summary.failed,
                              detail: text)
        case .pullRequest:
            let summary = PullRequestFollowUpSummary(text: text)
            event = ChatEvent(id: id, kind: "pr_follow_up", text: summary.sentence, title: summary.title, detail: text)
        case .coordinator:
            event = ChatEvent(id: id, kind: "coordinator_message", text: "Coordinator wrote", title: preview(text), detail: text)
        case .mission:
            event = ChatEvent(id: id, kind: "mission_updated", text: "Mission updated", detail: text)
        case .subagent:
            event = ChatEvent(id: id, kind: "subagent_message", text: "Subagent wrote", title: preview(text), detail: text)
        case .extension:
            event = ChatEvent(id: id, kind: "automatic_message", text: "Automatic message", title: preview(text), detail: text)
        case .slack:
            event = ChatEvent(id: id, kind: "slack_reply", text: "New reply in Slack", detail: text)
        case .control:
            event = ChatEvent(id: id, kind: "control_message", text: "Control chat wrote", title: preview(text), detail: text)
        case .watch:
            event = ChatEvent(id: id, kind: "watch_notice", text: "Watch fired", detail: text)
        }
        event.timestamp = timestamp
        return event
    }

    /// A subagent's answer or failure delivered to this chat.
    public static func subagent(id: String, notification: SubagentNotification, timestamp: Double? = nil) -> ChatEvent {
        ChatEvent(id: id, kind: notification.failed ? "subagent_failed" : "subagent_answered",
                  text: notification.failed ? "\(notification.name) failed" : "\(notification.name) answered",
                  title: preview(notification.text), timestamp: timestamp, destructive: notification.failed,
                  detail: notification.text.isEmpty ? nil : notification.text)
    }

    /// The record of an agent question. The reply follows as a user message.
    public static func question(id: String, question: AgentQuestion) -> ChatEvent {
        var lines = [question.question]
        if let context = question.context, !context.isEmpty { lines += ["", context] }
        if !question.options.isEmpty {
            lines += [""] + question.options.map { option in
                "- " + option.label + (option.detail.map { ": " + $0 } ?? "")
            }
        }
        return ChatEvent(id: id, kind: "question", text: "Agent asked", title: preview(question.question),
                         detail: lines.joined(separator: "\n"))
    }

    /// First non-empty line, with runs of whitespace collapsed and bounded for a one-line row.
    static func preview(_ text: String, limit: Int = 160) -> String? {
        guard let line = text.split(whereSeparator: \.isNewline).lazy
            .map({ $0.split(whereSeparator: \.isWhitespace).joined(separator: " ") })
            .first(where: { !$0.isEmpty }) else { return nil }
        return line.count > limit ? String(line.prefix(limit - 1)) + "…" : line
    }
}

/// The jobs extension's completion message: "- name (id): state, exit code N. Output: path" per job.
struct JobResultSummary: Equatable {
    struct Job: Equatable {
        let name: String
        let state: String
        let exitCode: Int?

        var failed: Bool { ["failed", "interrupted"].contains(state) || (exitCode.map { $0 != 0 } ?? false) }
    }

    let jobs: [Job]

    init(text: String) {
        let pattern = try! NSRegularExpression(pattern: #"^- (.+) \([^()\s]+\): ([A-Za-z_]+), exit code ([^.\s]+)\."#)
        jobs = text.split(whereSeparator: \.isNewline).compactMap { line in
            let line = String(line)
            guard let match = pattern.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
                  let name = Range(match.range(at: 1), in: line), let state = Range(match.range(at: 2), in: line),
                  let code = Range(match.range(at: 3), in: line) else { return nil }
            return Job(name: String(line[name]), state: line[state].lowercased(), exitCode: Int(line[code]))
        }
    }

    var failed: Bool { jobs.contains(where: \.failed) }

    var sentence: String {
        guard !jobs.isEmpty else { return "Background job finished" }
        if jobs.count == 1, let job = jobs.first {
            if job.failed { return "\(job.name) failed" }
            return job.state == "cancelled" ? "\(job.name) was stopped" : "\(job.name) finished"
        }
        let failures = jobs.filter(\.failed).count
        return failures > 0 ? "\(failures) of \(jobs.count) background jobs failed" : "\(jobs.count) background jobs finished"
    }

    /// The failing exit code for one job, or the job names for several.
    var title: String? {
        guard !jobs.isEmpty else { return nil }
        if jobs.count == 1, let job = jobs.first {
            guard let code = job.exitCode, code != 0 else { return nil }
            return "exit code \(code)"
        }
        return jobs.map(\.name).joined(separator: ", ")
    }
}

/// pilotd's automatic PR follow-up: which PRs, which attempt of the shared budget, and what needs fixing on them.
struct PullRequestFollowUpSummary: Equatable {
    struct Attempt: Equatable {
        let number: Int
        let limit: Int
    }

    let numbers: [Int]
    let problems: [String]
    /// "(2/3)" from the header line, so the user can tell a last attempt from a first one.
    let attempt: Attempt?

    init(text: String) {
        var numbers: [Int] = []
        var problems: [String] = []
        var attempt: Attempt?
        let number = try! NSRegularExpression(pattern: #"/pull/(\d+)"#)
        let header = try! NSRegularExpression(pattern: #"^Pilot automatic PR follow-up \((\d+)/(\d+)\)"#)
        func add(_ problem: String) { if !problems.contains(problem) { problems.append(problem) } }
        for line in text.split(whereSeparator: \.isNewline).map(String.init) {
            if attempt == nil, let match = header.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
               let current = Range(match.range(at: 1), in: line), let limit = Range(match.range(at: 2), in: line),
               let currentValue = Int(line[current]), let limitValue = Int(line[limit]) {
                attempt = Attempt(number: currentValue, limit: limitValue)
            } else if line.hasPrefix("PR "), let match = number.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
               let range = Range(match.range(at: 1), in: line), let value = Int(line[range]), !numbers.contains(value) {
                numbers.append(value)
            } else if line.hasPrefix("Failed CI checks") {
                add("failed checks")
            } else if line.contains("review thread") {
                let count = Int(line.prefix { $0.isNumber }) ?? 0
                add(count == 1 ? "1 review thread" : count > 1 ? "\(count) review threads" : "review threads")
            } else if line.hasPrefix("The PR has merge conflicts") {
                add("merge conflicts")
            } else if line.hasPrefix("The PR has diverged") {
                add("needs a rebase")
            }
        }
        self.numbers = numbers
        self.problems = problems
        self.attempt = attempt
    }

    var sentence: String {
        let labels = numbers.map { "#\($0)" }
        switch labels.count {
        case 0: return "Following up on a PR"
        case 1: return "Following up on PR \(labels[0])"
        default: return "Following up on PRs " + labels.dropLast().joined(separator: ", ") + " and " + labels.last!
        }
    }

    /// Attempt first, so a narrow row still shows it before the problem list truncates.
    var title: String? {
        let parts = (attempt.map { ["attempt \($0.number) of \($0.limit)"] } ?? []) + problems
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
