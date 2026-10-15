import AppKit
import PilotCore
import SwiftUI

/// Slack triage snapshots: table, board, common cases, a narrow window, empty states and the label settings.
/// Invented data only.
extension Snapshot {
    static func renderSlackTriage(model: AppModel, to directory: URL) async {
        let now = Fixtures.now
        let minute = 60_000.0
        let hour = 60 * minute
        let day = 24 * hour
        let labels = [
            SlackProjectLabel(name: "Product-owned", description: "Feature requests, copy and pricing questions.",
                              effect: .close),
            SlackProjectLabel(name: "Billing team", description: "Invoices, VAT and payment provider issues."),
        ]
        let tracking = ProjectTrackingConfig(
            slackChannels: ["C0SUPPORT1", "C0BUGS0002"],
            slackChannelNames: ["C0SUPPORT1": "support-escalations", "C0BUGS0002": "bugs"],
            slackLabels: labels)
        let projects = [
            Project(id: "p1", name: "acme-web", path: "\(Fixtures.home)/src/acme-web", tracking: tracking, createdAt: now),
            Project(id: "p2", name: "acme-api", path: "\(Fixtures.home)/src/acme-api", createdAt: now),
        ]
        model.client.loadFixture(projects: projects, sessions: [
            SessionSummary(id: "w1", title: "Export to CSV drops the last row", cwd: projects[0].path, projectId: "p1",
                           createdAt: now - 3 * hour, updatedAt: now - 5 * minute, state: "working"),
        ])
        func item(_ id: String, _ title: String, _ type: SlackMessageType, _ severity: SlackSeverity,
                  channel: String = "bugs", ago: Double, replies: Int, label: String? = nil,
                  status: SlackLocalStatus = .open, overrides: SlackOverrides = .init(),
                  sessions: [String]? = nil, closedByLabel: String? = nil, caseId: String? = nil) -> TrackedItem {
            let channelId = channel == "bugs" ? "C0BUGS0002" : "C0SUPPORT1"
            return TrackedItem(
                id: id, projectId: "p1", kind: .slack, externalId: "\(channelId)/\(id)", title: title,
                url: "https://example.slack.com/archives/\(channelId)/p1791892800000001", status: "open",
                metadata: ["channel": .string(channelId), "channelName": .string(channel),
                           "replies": .number(Double(replies))],
                dismissed: status == .dismissed, sessionId: sessions?.last, sessionIds: sessions,
                slack: SlackTriage(type: type, label: label, severity: severity, status: status, overrides: overrides,
                                   closedByLabel: closedByLabel),
                caseId: caseId, createdAt: now - ago, updatedAt: now - ago)
        }
        let items = [
            item("m1", "Checkout returns 500 for some EU customers since this morning", .bug, .critical,
                 channel: "support-escalations", ago: 2 * hour, replies: 7, caseId: "k1"),
            item("m2", "Export to CSV drops the last row", .bug, .high, ago: 5 * hour, replies: 3, status: .inProgress,
                 sessions: ["w1"]),
            item("m3", "Can we get the onboarding email in Spanish?", .request, .medium, ago: day, replies: 2,
                 label: "Product-owned", status: .dismissed, closedByLabel: "Product-owned"),
            item("m4", "Is the API rate limit per key or per account?", .question, .medium,
                 channel: "support-escalations", ago: day + 2 * hour, replies: 0),
            item("m5", "Invoice PDF shows the wrong VAT number for companies in Belgium", .bug, .medium, ago: 2 * day,
                 replies: 4, label: "Billing team", overrides: SlackOverrides(label: "Billing team"), caseId: "k2"),
            item("m6", "Typo on the pricing page footer", .bug, .low, ago: 3 * day, replies: 1, label: "Product-owned",
                 status: .dismissed, closedByLabel: "Product-owned"),
            item("m7", "Dashboard feels slow on Mondays?", .unknown, .low, channel: "support-escalations",
                 ago: 3 * day + hour, replies: 5, overrides: SlackOverrides(type: .unknown)),
            item("m8", "Password reset link expires before the email arrives for some customers", .bug, .high,
                 ago: 4 * day, replies: 6, status: .done, caseId: "k3"),
            item("m9", "Could the weekly report include refunds?", .request, .low, channel: "support-escalations",
                 ago: 5 * day, replies: 2, status: .inProgress),
            item("m10", "Login page shows a blank screen on an old tablet", .bug, .medium, ago: 6 * day, replies: 0,
                 status: .dismissed, caseId: "k4"),
            item("m11", "Card payment times out at the tax step for French customers", .bug, .high,
                 channel: "support-escalations", ago: day + 5 * hour, replies: 3, caseId: "k1"),
            item("m12", "Customer in Germany charged twice after a checkout error", .bug, .critical, ago: 3 * day,
                 replies: 9, status: .inProgress, caseId: "k1"),
            item("m13", "Invoice email preview lists our VAT number for a Dutch customer", .bug, .low, ago: 8 * day,
                 replies: 1, label: "Billing team", caseId: "k2"),
        ]
        let cases = SlackCommonCaseList(cases: [
            SlackCommonCase(id: "k1", name: "Checkout fails for EU card payments",
                            description: "Card payments in Germany and France return a 500 after the tax service times out, and some are charged twice.",
                            count: 6, severityMix: ["critical": 2, "high": 3, "medium": 1], firstSeen: now - 9 * day,
                            lastSeen: now - 2 * hour, trend: .rising),
            SlackCommonCase(id: "k2", name: "Invoices show the wrong VAT number",
                            description: "Invoice PDFs and email previews use the company's VAT number instead of the customer's.",
                            count: 4, severityMix: ["medium": 3, "low": 1], label: "Billing team",
                            firstSeen: now - 20 * day, lastSeen: now - 2 * day, trend: .steady),
            SlackCommonCase(id: "k3", name: "Password reset emails arrive after the link expires",
                            description: "Reset links expire before the email reaches some inboxes.", count: 3,
                            severityMix: ["high": 2, "medium": 1], firstSeen: now - 26 * day, lastSeen: now - 4 * day,
                            trend: .fading),
            SlackCommonCase(id: "k4", name: "Login page blank on older browsers",
                            description: "The login page renders nothing on old tablets and browsers.", count: 2,
                            severityMix: ["medium": 1, "low": 1], firstSeen: now - 18 * day, lastSeen: now - 6 * day,
                            trend: .fading),
        ])
        model.client.loadTrackingFixture(TrackingFixture(
            sources: [TrackingSource(id: "p1:slack", projectId: "p1", kind: .slack, label: "Slack", configured: true,
                                     status: .ok, lastPolledAt: now - 3 * minute)],
            items: items,
            corrections: [
                SlackCorrection(itemId: "m5", summary: "Invoice PDF shows the wrong VAT number for companies in Belgium",
                                correctedAt: now - hour, values: SlackOverrides(label: "Billing team")),
                SlackCorrection(itemId: "m7", summary: "Dashboard feels slow on Mondays?", correctedAt: now - 2 * hour,
                                values: SlackOverrides(type: .unknown)),
                SlackCorrection(itemId: "m6", summary: "Typo on the pricing page footer", correctedAt: now - day,
                                values: SlackOverrides(label: "Product-owned", severity: .low)),
            ],
            guides: [.slack: TriageGuide(kind: .slack, text: """
                Invoices, VAT numbers and payment provider errors get the Billing team label.
                Feature requests, pricing and copy changes get the Product-owned label and type Request.
                Slowness reports without an error, page or time are Unknown with Low severity.
                Typos and wording on marketing pages are Low severity bugs.
                Checkout or sign-in failures for many customers are Critical bugs.
                Questions about rate limits or quotas are type Question.
                Exports that drop or duplicate rows are High severity bugs.
                """, updatedAt: now - 3 * hour, throughSeq: 12)],
            cases: cases))
        let size = CGSize(width: 1180, height: 640)
        let excerpts: [String: SlackExcerptState] = [
            "m5": .loaded(SlackExcerpt(itemId: "m5", author: "Dana Okafor", text: """
                Customers in Belgium get invoices with our Dutch VAT number instead of their own. \
                It started after Tuesday's release.
                Example: invoice INV-20431, the PDF and the email preview both show it.
                """)),
            "m1": .loaded(SlackExcerpt(itemId: "m1", author: "Sam Rivera", text: """
                Checkout fails with a 500 for some customers in Germany and France since about 9:00. \
                Card payments only, bank transfers still work. Three support tickets so far, \
                all on the new checkout page. Logs show a timeout talking to the tax service, then \
                a retry that sends the order twice, so a few customers were charged two times before \
                the page gave up and showed the error…
                """, truncated: true)),
            "m3": .unavailable("Sign in to Slack to read this message."),
        ]
        await render(SlackTriagePage(projectId: "p1", fixture: items, layout: .table, selection: "m5",
                                     excerpts: excerpts), size: size,
                     to: directory.appending(path: "slack-triage-table.png"))
        await render(SlackTriagePage(projectId: "p1", fixture: items, layout: .table, selection: "m3",
                                     filter: .init(showHidden: true), excerpts: excerpts),
                     size: size, to: directory.appending(path: "slack-triage-hidden.png"))
        await render(SlackTriagePage(projectId: "p1", fixture: items, layout: .board, selection: "m2"), size: size,
                     to: directory.appending(path: "slack-triage-board.png"))
        await render(SlackTriagePage(projectId: "p1", fixture: items, layout: .cases,
                                     filter: .init(caseId: "k1"), cases: cases), size: size,
                     to: directory.appending(path: "slack-triage-cases.png"))
        await render(SlackTriagePage(projectId: "p1", fixture: items, layout: .cases, cases: SlackCommonCaseList(cases: [])),
                     size: CGSize(width: 980, height: 420), to: directory.appending(path: "slack-triage-cases-empty.png"))
        await render(SlackTriagePage(projectId: "p1", fixture: items, layout: .table, selection: "m1",
                                     filter: .init(caseId: "k1"), excerpts: excerpts, cases: cases), size: size,
                     to: directory.appending(path: "slack-triage-case-table.png"))
        await render(SlackCaseSplitSheet(entry: cases.cases[0], members: SlackCaseText.members(of: "k1", in: items),
                                         now: Date(timeIntervalSince1970: now / 1000)) { _, _ in },
                     size: CGSize(width: 520, height: 400), to: directory.appending(path: "slack-case-split.png"))
        await render(CreateMissionSheet(projectId: "p1", sourceSessionId: nil,
                                        prefill: SlackCaseText.missionDraft(cases.cases[0], projectId: "p1",
                                                                            members: SlackCaseText.members(of: "k1", in: items))),
                     size: CGSize(width: 500, height: 640), to: directory.appending(path: "slack-case-mission.png"))
        await render(SlackTriagePage(projectId: "p1", fixture: items, layout: .table, selection: "m1",
                                     excerpts: excerpts),
                     size: CGSize(width: 820, height: 560), to: directory.appending(path: "slack-triage-narrow.png"))
        await render(SlackTriagePage(projectId: "p1", fixture: items, layout: .table, selection: nil,
                                     filter: .init(type: .question, query: "refund")),
                     size: CGSize(width: 980, height: 420), to: directory.appending(path: "slack-triage-no-match.png"))
        await render(SlackTriagePage(projectId: "p2", fixture: []), size: CGSize(width: 980, height: 420),
                     to: directory.appending(path: "slack-triage-not-configured.png"))
        let editor = ProjectEditor()
        editor.load(projects[0])
        await render(SettingsColumn { SlackLabelsSection(project: projects[0], editor: editor) },
                     size: CGSize(width: 600, height: 860), to: directory.appending(path: "slack-labels-settings.png"))
        print("snapshots written to \(directory.path)")
    }
}
