import AppKit
import GhosttyTerminal
import PilotCore
import SwiftUI

/// `Pilot --snapshot <dir>` renders fixture screens as PNGs and quits. Most render offscreen;
/// the completion preview briefly opens a window to capture its floating picker.
/// Used to review the UI without screen-recording permission or a live daemon.
@MainActor
enum Snapshot {
    static func runIfRequested() -> Bool {
        let arguments = CommandLine.arguments
        if let index = arguments.firstIndex(of: "--transcript-opening-check"), index + 1 < arguments.count {
            Task { await TranscriptOpeningCheck.run(directory: URL(filePath: arguments[index + 1])) }
            return true
        }
        if arguments.contains("--artifact-scroll-check") {
            Task { await ArtifactScrollCheck.run() }
            return true
        }
        if arguments.contains("--performance-check") {
            Task { await PerformanceCheck.run() }
            return true
        }
        if arguments.contains("--mission-tabs-check") {
            Task { await MissionTabsCheck.run() }
            return true
        }
        if arguments.contains("--terminal-resource-test") {
            TerminalResourceTest.run()
            return true
        }
        if arguments.contains("--queue-edit-test") {
            Task { await QueueEditingTest.run() }
            return true
        }
        if let index = arguments.firstIndex(of: "--artifact-render-test") {
            let directory = arguments.count > index + 1 ? arguments[index + 1] : "/tmp/pilot-artifact-test"
            Task { await ArtifactRenderTest.run(directory: URL(filePath: directory)) }
            return true
        }
        if arguments.contains("--terminal-exit-test") {
            Task { await terminalExitTest(directory: URL(filePath: arguments.last ?? "/tmp")) }
            return true
        }
        guard let index = arguments.firstIndex(of: "--snapshot"), arguments.count > index + 1 else { return false }
        let directory = URL(filePath: arguments[index + 1])
        Task { await renderAll(to: directory) }
        return true
    }

    private static func renderAll(to directory: URL) async {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        NSApp.appearance = NSAppearance(named: .aqua)
        for window in NSApp.windows { window.orderOut(nil) }

        let model = AppModel.shared
        model.client.loadFixture(projects: Fixtures.projects, sessions: Fixtures.sessions)
        model.client.fixtureChangeSummaries = Dictionary(uniqueKeysWithValues: Fixtures.sessions.map {
            ($0.id, SessionChangeSummary(base: "origin/main", branch: $0.branch, fileCount: $0.id == "s1" ? 2 : 0,
                                        additions: $0.id == "s1" ? 13 : 0, deletions: $0.id == "s1" ? 1 : 0))
        })
        model.client.fixtureModels = ModelList(
            models: [
                ModelOption(id: "anthropic/claude-opus-5-5", provider: "anthropic", name: "Claude Opus 5.5"),
                ModelOption(id: "openai-codex/gpt-6.1-sol", provider: "openai-codex", name: "GPT-6.1 Sol"),
            ],
            defaultModel: "openai-codex/gpt-6.1-sol"
        )
        model.client.fixtureBranches = RemoteBranchList(
            branches: ["feat/billing", "fix/invoice-rounding", "main"], defaultBranch: "main"
        )
        model.daemon.markRunningForSnapshot()
        let size = CGSize(width: 1360, height: 860)

        if CommandLine.arguments.contains("--delegated-tasks-only") {
            await renderDelegatedTasks(model: model, to: directory)
            print("snapshots written to \(directory.path)")
            exit(0)
        }

        if CommandLine.arguments.contains("--home-overview-only") {
            let now = Fixtures.now
            let sessions = [
                SessionSummary(id: "home-failed", title: "Fix checkout validation", cwd: "/tmp/demo", projectId: "p1",
                               createdAt: now, updatedAt: now, state: "idle", outcome: .failed, outcomeAt: now),
                SessionSummary(id: "home-result", title: "Review the accessibility audit and keyboard navigation improvements",
                               cwd: "/tmp/demo", projectId: "p2", createdAt: now, updatedAt: now, state: "idle",
                               outcome: .done, outcomeAt: now),
                SessionSummary(id: "home-coordinator", title: "Release coordinator", cwd: "/tmp/demo", projectId: "p1",
                               createdAt: now, updatedAt: now, state: "working"),
                SessionSummary(id: "home-archived", title: "Previous coordinator", cwd: "/tmp/demo", projectId: "p2",
                               createdAt: now, updatedAt: now, state: "idle", archivedAt: now),
            ]
            model.client.loadFixture(projects: Fixtures.projects, sessions: sessions)
            let missions = [
                Mission(id: "home-release", projectId: "p1", title: "Ship the next release", goal: "",
                        coordinatorSessionId: "home-coordinator", createdAt: now, updatedAt: now, needsYouCount: 2),
                Mission(id: "home-long", projectId: "p2", title: "Improve accessibility across every window, toolbar and composer",
                        goal: "", createdAt: now - 1, updatedAt: now),
                Mission(id: "home-done", projectId: "p2", title: "Previous release", goal: "", status: .done,
                        coordinatorSessionId: "home-archived", createdAt: now, updatedAt: now),
                Mission(id: "home-missing", projectId: "p1", title: "Older migration", goal: "", status: .archived,
                        coordinatorSessionId: "missing", createdAt: now, updatedAt: now),
            ]
            model.client.handle(.missions(missions))
            for (name, width, appearance) in [("wide", 800.0, NSAppearance.Name.aqua),
                                              ("narrow", 420.0, .aqua), ("dark", 800.0, .darkAqua)] {
                NSApp.appearance = NSAppearance(named: appearance)
                await render(HomeOverview().padding(24).background(Theme.background),
                             size: CGSize(width: width, height: 500),
                             to: directory.appending(path: "home-overview-\(name).png"), appearance: appearance)
            }
            model.client.loadFixture(projects: Fixtures.projects, sessions: [])
            model.client.handle(.missions([]))
            await render(HomeOverview().padding(24).background(Theme.background), size: CGSize(width: 800, height: 240),
                         to: directory.appending(path: "home-overview-empty.png"))
            NSApp.terminate(nil)
            return
        }

        // Capture workspace context in the real native toolbar, not above the composer.
        if CommandLine.arguments.contains("--session-context-only") {
            model.inspectorVisible = false
            for mode in [ChatMode.build, .ask] {
                for archived in [false, true] {
                    let session = SessionSummary(
                        id: "context-\(mode.rawValue)-\(archived)", title: "Workspace context", cwd: Fixtures.projects[0].path,
                        projectId: "p1", branch: mode == .build ? "fix/workspace-context-toolbar" : nil, createdAt: Fixtures.now,
                        updatedAt: Fixtures.now, state: "idle", model: "anthropic/claude-opus-5-5",
                        archivedAt: archived ? Fixtures.now : nil, mode: mode,
                        sourceBranch: mode == .ask ? "main" : nil)
                    model.client.loadFixture(projects: Fixtures.projects, sessions: [session])
                    model.selectedSessionId = session.id
                    for _ in 0..<8 { try? await Task.sleep(for: .milliseconds(100)) }
                    guard let window = NSApp.windows.first(where: { $0.toolbar != nil }),
                          let frame = window.contentView?.superview else {
                        print("No native toolbar window available")
                        exit(1)
                    }
                    for width in [860.0, 2000.0] {
                        window.setContentSize(CGSize(width: width, height: 600))
                        window.setFrameOrigin(NSPoint(x: 100, y: 100))
                        window.makeKeyAndOrderFront(nil)
                        for _ in 0..<8 { try? await Task.sleep(for: .milliseconds(100)) }
                        snapshot(frame, to: directory.appending(path: "context-\(mode.rawValue)-\(archived ? "archived" : "live")-\(Int(width)).png"))
                    }
                }
            }
            NSApp.terminate(nil)
            return
        }

        if CommandLine.arguments.contains("--settings-only") {
            let now = Date().timeIntervalSince1970 * 1000
            model.client.mcp.loadFixture(McpStatus(servers: [
                McpServerStatus(name: "datadog", transport: .http, state: .needsSignIn, canSignIn: true, checkedAt: now),
                McpServerStatus(name: "notion", transport: .http, state: .needsSignIn, canSignIn: true, checkedAt: now,
                                signIn: McpSignInState(state: .waiting, startedAt: now, expiresAt: now + 300_000)),
                McpServerStatus(name: "local-docs", transport: .stdio, state: .failed,
                                problem: "Couldn't start the server.", checkedAt: now),
                McpServerStatus(name: "linear", transport: .http, state: .connected, tools: 42, canSignIn: true,
                                checkedAt: now),
                McpServerStatus(name: "slack", transport: .http, state: .connected, tools: 21, canSignIn: true,
                                checkedAt: now),
                McpServerStatus(name: "archive", transport: .stdio, state: .disabled),
            ]))
            let pages: [(String, SettingsTab)] = SettingsTab.general.map { ($0.title.lowercased(), $0) }
                + [("project", .project(Fixtures.projects[0].id))]
            for (name, tab) in pages {
                model.settingsTab = tab
                await render(SettingsView(), size: CGSize(width: 780, height: 580),
                             to: directory.appending(path: "settings-\(name).png"))
            }
            await render(SettingsView(), size: CGSize(width: 1240, height: 640), to: directory.appending(path: "settings-wide.png"))
            await render(SettingsView(), size: CGSize(width: 640, height: 440), to: directory.appending(path: "settings-narrow.png"))
            NSApp.terminate(nil)
            return
        }

        if CommandLine.arguments.contains("--long-messages-only") {
            let report = "I had a crash:\n\nTranslated Report\nProcess: Pilot\nException: Stack overflow\nThread 0:\n"
                + String(repeating: "SwiftUI menuHostDidChangeMenuItems\n", count: 2000)
            let response = "## Investigation\n\n" + String(repeating: "The menu update repeated recursively.\n", count: 40)
            for width in [400.0, 760.0] {
                renderMessageFixture(VStack(alignment: .leading, spacing: 20) {
                    Text("Long user messages fold, agent replies stay in full").font(.headline)
                    UserMessage(text: report)
                    MarkdownView(text: response)
                    Divider()
                    Text("The rest of the conversation stays in view.").font(.body)
                    Spacer()
                }.padding(24), size: CGSize(width: width, height: 520),
                    to: directory.appending(path: "long-messages-\(Int(width)).png"))
            }
            let expansion = ExpansionState()
            expansion.expanded = true
            let expanded = (1...17).map { "Frame \($0): SwiftUI menu update" }.joined(separator: "\n")
            renderMessageFixture(VStack(alignment: .leading, spacing: 16) {
                Text("Expanded message").font(.headline)
                UserMessage(text: expanded, expansion: expansion)
                Spacer()
            }.padding(24), size: CGSize(width: 760, height: 600),
                to: directory.appending(path: "long-message-expanded.png"))
            print("snapshots written to \(directory.path)")
            NSApp.terminate(nil)
            return
        }

        if CommandLine.arguments.contains("--questions-only") {
            // An agent question in place of the composer, single and multi-select, then its answered record.
            let base = Fixtures.sessions.first { $0.id == "s5" }!
            let session = SessionSummary(id: base.id, title: base.title, cwd: base.cwd, createdAt: base.createdAt,
                                         updatedAt: base.updatedAt, state: "parked", outcome: .question,
                                         outcomeAt: base.outcomeAt, outcomeReason: "Where should the retry logic live?")
            for (name, transcript) in [
                ("question-single", Fixtures.questionTranscript(multiSelect: false, answered: false)),
                ("question-multi", Fixtures.questionTranscript(multiSelect: true, answered: false)),
                ("question-answered", Fixtures.questionTranscript(multiSelect: false, answered: true)),
            ] {
                await render(
                    Frame(title: session.title, subtitle: "pilot", status: session.status, session: session) {
                        ChatView(session: session, feed: SessionFeed(sessionId: session.id, transcript: transcript))
                    },
                    size: CGSize(width: 1000, height: 820),
                    to: directory.appending(path: "\(name).png")
                )
            }
            print("snapshots written to \(directory.path)")
            NSApp.terminate(nil)
            return
        }

        // Capture the real SwiftUI window toolbar, including native shared backgrounds.
        let inspectorTogglesOnly = CommandLine.arguments.contains("--inspector-toggles-only")
        if CommandLine.arguments.contains("--session-toolbar-only") || inspectorTogglesOnly {
            model.client.fixtureChanges = SessionChanges(base: Fixtures.changes.base,
                branch: "refactor/remove-agent-status-reporting", files: Fixtures.changes.files, diff: Fixtures.changes.diff)
            let session = SessionSummary(
                id: "toolbar", title: "Remove agent status reporting", cwd: Fixtures.projects[0].path,
                projectId: "p1", branch: "refactor/remove-agent-status-reporting", createdAt: Fixtures.now,
                updatedAt: Fixtures.now, state: "idle", model: "openai-codex/gpt-6.1-sol",
                pullRequest: SessionPullRequest(number: 61, url: "https://github.com/babariviere/pilot/pull/61",
                                               title: "Remove agent status reporting", state: .merged, checkedAt: Fixtures.now),
                subagents: inspectorTogglesOnly ? Fixtures.subagentSession.subagents : nil)
            model.client.loadFixture(projects: Fixtures.projects, sessions: [session])
            model.selectedSessionId = session.id
            model.inspectorVisible = true
            model.inspectorTab = .changes
            for _ in 0..<10 { try? await Task.sleep(for: .milliseconds(100)) }
            guard let window = NSApp.windows.first(where: { $0.toolbar != nil }),
                  let frame = window.contentView?.superview else {
                print("No native toolbar window available")
                exit(1)
            }
            window.setContentSize(CGSize(width: 1280, height: 600))
            window.setFrameOrigin(NSPoint(x: 100, y: 100))
            window.makeKeyAndOrderFront(nil)
            for _ in 0..<8 { try? await Task.sleep(for: .milliseconds(100)) }
            if inspectorTogglesOnly {
                NSApp.activate(ignoringOtherApps: true)
                for appearance in [NSAppearance.Name.aqua, .darkAqua] {
                    NSApp.appearance = NSAppearance(named: appearance)
                    for tab in [InspectorTab.changes, .terminal, .agents, .artifacts, .links] {
                        model.inspectorTab = tab
                        model.inspectorVisible = true
                        for _ in 0..<8 { try? await Task.sleep(for: .milliseconds(100)) }
                        snapshot(frame, to: directory.appending(path: "inspector-\(tab)-\(appearance.rawValue).png"))
                    }
                    model.inspectorVisible = false
                    for _ in 0..<8 { try? await Task.sleep(for: .milliseconds(100)) }
                    snapshot(frame, to: directory.appending(path: "inspector-closed-\(appearance.rawValue).png"))
                }
                print("snapshots written to \(directory.path)")
                NSApp.terminate(nil)
                return
            }
            snapshot(frame, to: directory.appending(path: "session-toolbar.png"))
            window.setContentSize(CGSize(width: 860, height: 600))
            for _ in 0..<8 { try? await Task.sleep(for: .milliseconds(100)) }
            snapshot(frame, to: directory.appending(path: "session-toolbar-narrow.png"))
            // A session that split its work: an open PR on the current branch and an earlier merged one.
            let current = SessionPullRequest(number: 74, url: "https://github.com/babariviere/pilot/pull/74",
                                             title: "Remove agent status reporting", state: .open,
                                             checkedAt: Fixtures.now, branch: "refactor/remove-agent-status-reporting")
            let earlier = SessionPullRequest(number: 61, url: "https://github.com/babariviere/pilot/pull/61",
                                             title: "Extract status helpers", state: .merged,
                                             checkedAt: Fixtures.now, branch: "refactor/extract-status-helpers")
            let multiple = SessionSummary(
                id: "toolbar", title: "Remove agent status reporting", cwd: Fixtures.projects[0].path,
                projectId: "p1", branch: "refactor/remove-agent-status-reporting", createdAt: Fixtures.now,
                updatedAt: Fixtures.now, state: "idle", model: "openai-codex/gpt-6.1-sol",
                pullRequest: current, pullRequests: [current, earlier])
            model.client.loadFixture(projects: Fixtures.projects, sessions: [multiple])
            window.setContentSize(CGSize(width: 1280, height: 600))
            for _ in 0..<8 { try? await Task.sleep(for: .milliseconds(100)) }
            snapshot(frame, to: directory.appending(path: "session-toolbar-multiple-prs.png"))
            window.setContentSize(CGSize(width: 860, height: 600))
            for _ in 0..<8 { try? await Task.sleep(for: .milliseconds(100)) }
            snapshot(frame, to: directory.appending(path: "session-toolbar-multiple-prs-narrow.png"))
            model.inspectorVisible = false
            for _ in 0..<8 { try? await Task.sleep(for: .milliseconds(100)) }
            snapshot(frame, to: directory.appending(path: "session-subtitle-inspector-closed.png"))
            print("snapshots written to \(directory.path)")
            NSApp.terminate(nil)
            return
        }

        // Real sidebar preview: pinned chats lead in their own group, polling does not reset old ages,
        // and unpinned terminal PRs stay below other chats without unread dots.
        if CommandLine.arguments.contains("--session-ordering-only") {
            model.client.loadFixture(projects: [Fixtures.projects[0]], sessions: Fixtures.orderingSessions)
            model.selectedSessionId = nil
            await render(SessionSidebar(model: model, client: model.client),
                         size: CGSize(width: 420, height: 680),
                         to: directory.appending(path: "session-ordering.png"))
            print("snapshots written to \(directory.path)")
            exit(0)
        }
        // Missions: sidebar section and mission page tabs, from static fixtures.
        if CommandLine.arguments.contains("--archive-only") {
            let project = Project(id: "archive-project", name: "Repository with a deliberately long project name",
                                  path: "/projects/archive", createdAt: 1)
            let json = #"""
            [{"mission":{"id":"archive-mission","projectId":"archive-project",
              "title":"A completed goal with a deliberately long title for archive browsing",
              "goal":"","status":"done","briefRevision":1,"createdAt":1,"updatedAt":1},
              "decisions":[],"comments":[],"tasks":[],"artifacts":[],"resources":[],"events":[]},
             {"mission":{"id":"empty-mission","projectId":"archive-project",
              "title":"An archived goal with no archived chats",
              "goal":"","status":"archived","briefRevision":1,"createdAt":1,"updatedAt":1},
              "decisions":[],"comments":[],"tasks":[],"artifacts":[],"resources":[],"events":[]}]
            """#
            let details = try! JSONDecoder().decode([MissionDetail].self, from: Data(json.utf8))
            let sessions = [
                SessionSummary(id: "archive-long", title: "A retained chat with a long title that should wrap without hiding the Restore action",
                               cwd: project.path, projectId: project.id, createdAt: 1, updatedAt: 2, state: "idle",
                               archivedAt: Fixtures.now, missionId: "archive-mission"),
                SessionSummary(id: "archive-short", title: "Earlier implementation", cwd: project.path,
                               projectId: project.id, createdAt: 1, updatedAt: 2, state: "idle",
                               archivedAt: Fixtures.now - 86_400_000, missionId: "archive-mission"),
                SessionSummary(id: "archive-unrelated", title: "An unrelated archived chat", cwd: project.path,
                               projectId: project.id, createdAt: 1, updatedAt: 2, state: "idle", archivedAt: Fixtures.now),
            ]
            model.client.loadFixture(projects: [project], sessions: sessions)
            model.client.loadMissionFixture(details)
            for width in [460.0, 900.0] {
                model.showArchive(missionId: "archive-mission")
                await render(ArchiveView(), size: CGSize(width: width, height: 600),
                             to: directory.appending(path: "archive-filter-\(Int(width)).png"))
                model.pendingSessionActions = ["archive-long"]
                await render(ArchiveView(), size: CGSize(width: width, height: 600),
                             to: directory.appending(path: "archive-restoring-\(Int(width)).png"))
                model.pendingSessionActions = []
                model.showArchive(missionId: "empty-mission")
                await render(ArchiveView(), size: CGSize(width: width, height: 600),
                             to: directory.appending(path: "archive-empty-\(Int(width)).png"))
            }
            print("snapshots written to \(directory.path)")
            exit(0)
        }

        // Overview links grouped by provider, with many pull requests in every state.
        if CommandLine.arguments.contains("--mission-links-only") {
            await renderMissionLinks(model: model, to: directory)
            print("snapshots written to \(directory.path)")
            exit(0)
        }

        if CommandLine.arguments.contains("--missions-only") {
            let now = Fixtures.now
            func member(_ id: String, _ title: String, state: String = "idle", outcome: SessionOutcome? = nil,
                        ago: Double, pinned: Bool = false, mission: String = "m1") -> SessionSummary {
                SessionSummary(id: id, title: title, cwd: Fixtures.projects[0].path, projectId: "p1",
                               branch: "feat/\(id)", createdAt: now - ago, updatedAt: now - ago, state: state,
                               outcome: outcome, outcomeAt: outcome == nil ? nil : now - ago, pinned: pinned, missionId: mission)
            }
            let sessions = [
                member("coord", "Plan API v2 migration", ago: 3_600_000),
                member("auth", "Port auth endpoints", state: "working", ago: 60_000, pinned: true),
                member("pagination", "Cursor pagination", outcome: .done, ago: 900_000),
                member("errors", "Error envelope", outcome: .failed, ago: 1_800_000),
                member("draft", "Plan search ranking", state: "working", ago: 30_000, mission: "m3"),
                SessionSummary(id: "solo", title: "Fix flaky CI cache", cwd: Fixtures.projects[0].path, projectId: "p1",
                               createdAt: now - 7_200_000, updatedAt: now - 7_200_000, state: "idle"),
            ]
            let json = """
            [{"mission":{"id":"m1","projectId":"p1","title":"API v2","goal":"Ship the v2 public API with cursor pagination, a single error envelope and token auth, without breaking v1 clients.","status":"active","coordinatorSessionId":"coord","needsYouCount":1,"briefRevision":4,"createdAt":\(now - 86_400_000),"updatedAt":\(now)},
              "brief":{"missionId":"m1","revision":4,"markdown":"# API v2\\n\\n## Scope\\n- Cursor pagination on every list endpoint\\n- One error envelope\\n- Token auth replaces session cookies\\n\\n## Out of scope\\nGraphQL and webhook payloads stay on v1 until the SDK is regenerated.\\n","authorSessionId":"coord","createdAt":\(now - 600_000)},
              "decisions":[{"id":"d1","text":"Cursors are opaque base64 strings.","createdAt":1,"updatedAt":1},
                           {"id":"d2","text":"v1 stays frozen; no new fields.","authorSessionId":"coord","createdAt":1,"updatedAt":1}],
              "comments":[{"id":"c1","text":"Should rate-limit errors share the envelope?","anchor":"One error envelope","authorSessionId":"errors","createdAt":\(now - 500_000)}],
              "tasks":[{"id":"t1","number":1,"title":"Inventory v1 endpoints","status":"done","order":1,"milestone":"Foundations","sessionId":"coord","createdAt":1,"updatedAt":1},
                       {"id":"t2","number":2,"title":"Port auth endpoints","body":"Move /auth/* to v2 with token refresh and the new error envelope.","status":"in_progress","order":2,"milestone":"Foundations","sessionId":"auth","createdAt":1,"updatedAt":1},
                       {"id":"t3","number":3,"title":"Cursor pagination","status":"in_review","order":3,"milestone":"Endpoints","sessionId":"pagination","createdAt":1,"updatedAt":1},
                       {"id":"t4","number":4,"title":"Error envelope","body":"Waiting on the rate-limit decision.","status":"blocked","order":4,"milestone":"Endpoints","sessionId":"errors","createdAt":1,"updatedAt":1},
                       {"id":"t5","number":5,"title":"SDK regeneration","status":"todo","order":5,"milestone":"Release","createdAt":1,"updatedAt":1},
                       {"id":"t6","number":6,"title":"Migration guide","body":"Document breaking changes for v1 clients.","status":"todo","order":6,"milestone":"Release","createdAt":1,"updatedAt":1}],
              "artifacts":[{"artifactId":"a1","sessionId":"coord","title":"Endpoint map","kind":"html","linkedAt":1},
                           {"artifactId":"a2","sessionId":"pagination","taskId":"t3","title":"Cursor format","kind":"swiftui","revision":2,"linkedAt":1}],
              "resources":[{"id":"r1","url":"https://linear.app/acme/project/api-v2","kind":"linear.project","externalId":"api-v2","title":"API v2","createdAt":1},
                           {"id":"r2","url":"https://github.com/acme/api/pull/412","kind":"github.pr","externalId":"acme/api#412","createdAt":1},
                           {"id":"r3","url":"https://acme.slack.com/archives/C1/p1","kind":"slack.thread","title":"#api-v2","createdAt":1},
                           {"id":"r5","taskId":"t2","url":"https://linear.app/acme/issue/API-41","kind":"linear.issue","externalId":"API-41","createdAt":1},
                           {"id":"r6","taskId":"t4","url":"https://github.com/acme/api/issues/398","kind":"github.issue","externalId":"acme/api#398","createdAt":1},
                           {"id":"r7","url":"https://example.com/api-v2-rfc","kind":"url","title":"API v2 RFC","createdAt":1},
                           {"id":"r4","taskId":"t3","url":"https://github.com/acme/api/pull/412","kind":"github.pr","externalId":"acme/api#412","pullRequest":{"number":412,"url":"https://github.com/acme/api/pull/412","title":"Cursor pagination","state":"open","checkedAt":1},"createdAt":1}],
              "events":[{"id":10,"kind":"update","text":"Auth port is halfway; token refresh remains.","sessionId":"auth","health":"on_track","at":\(now - 120_000)},
                        {"id":9,"kind":"handoff","text":"Pagination is ready for review. Cursor encoding follows the decision; the SDK task can start once #412 merges.","sessionId":"pagination","at":\(now - 900_000)},
                        {"id":8,"kind":"task","text":"Error envelope is blocked on the rate-limit question.","sessionId":"errors","at":\(now - 1_800_000)},
                        {"id":7,"kind":"brief","text":"Brief revision 4","sessionId":"coord","at":\(now - 90_000_000)}]},
             {"mission":{"id":"m2","projectId":"p1","title":"Billing cleanup","goal":"Remove legacy invoices.","status":"done","briefRevision":1,"createdAt":\(now - 900_000_000),"updatedAt":1},
              "decisions":[],"comments":[],"tasks":[],"artifacts":[],"resources":[],"events":[]},
             {"mission":{"id":"m3","projectId":"p1","title":"Search ranking","goal":"","status":"active","coordinatorSessionId":"draft","briefRevision":0,"createdAt":\(now - 60_000),"updatedAt":\(now)},
              "decisions":[],"comments":[],"tasks":[],"artifacts":[],"resources":[],"events":[{"id":1,"kind":"created","text":"Mission created","at":\(now - 60_000)}]},
             {"mission":{"id":"m4","projectId":"p1","title":"Docs refresh","goal":"Rewrite the getting-started guide for v2.","status":"active","briefRevision":0,"createdAt":\(now - 120_000),"updatedAt":\(now)},
              "decisions":[],"comments":[],"tasks":[],"artifacts":[],"resources":[],"events":[]}]
            """
            // Task phases, loaded only for their own captures so the other mission screens stay unchanged.
            let phasesJSON = """
            [{"mission":{"id":"m5","projectId":"p1","title":"Mission pages","goal":"Track shared work by phase.","status":"active","briefRevision":1,"createdAt":\(now - 172_800_000),"updatedAt":\(now)},
              "decisions":[],"comments":[],"artifacts":[],"resources":[],"events":[],
              "tasks":[{"id":"p1","number":1,"title":"Mission store and API","status":"done","order":1,"milestone":"Phase 1","createdAt":1,"updatedAt":1},
                       {"id":"p2","number":2,"title":"Mission page with tabs","status":"done","order":2,"milestone":"Phase 1","createdAt":1,"updatedAt":1},
                       {"id":"p3","number":3,"title":"Mission tool for chats","status":"done","order":3,"milestone":"Phase 1","createdAt":1,"updatedAt":1},
                       {"id":"p4","number":4,"title":"Kanban board","status":"dropped","order":4,"milestone":"Phase 1","createdAt":1,"updatedAt":1},
                       {"id":"p5","number":5,"title":"Group tasks by phase","status":"in_progress","order":5,"milestone":"Phase 1 polish","sessionId":"auth","createdAt":1,"updatedAt":1},
                       {"id":"p6","number":6,"title":"Calmer link chips","status":"done","order":6,"milestone":"Phase 1 polish","createdAt":1,"updatedAt":1},
                       {"id":"p7","number":7,"title":"Show task from a link","status":"in_review","order":7,"milestone":"Phase 1 polish","sessionId":"pagination","createdAt":1,"updatedAt":1},
                       {"id":"p8","number":8,"title":"Task descriptions fold past two lines","body":"Long descriptions fold with Show more.","status":"todo","order":8,"milestone":"Phase 1 polish","createdAt":1,"updatedAt":1},
                       {"id":"p9","number":9,"title":"Sidebar progress line","status":"done","order":9,"milestone":"Phase 1 polish","createdAt":1,"updatedAt":1},
                       {"id":"p10","number":10,"title":"Archive view for missions","status":"blocked","body":"Waiting on the archive API.","order":10,"milestone":"Phase 1 polish","sessionId":"errors","createdAt":1,"updatedAt":1},
                       {"id":"p11","number":11,"title":"Inline status picker","status":"dropped","order":11,"milestone":"Phase 1 polish","createdAt":1,"updatedAt":1},
                       {"id":"p12","number":12,"title":"Coordinator starts ready tasks","status":"todo","order":12,"milestone":"Coordinator automation","createdAt":1,"updatedAt":1},
                       {"id":"p13","number":13,"title":"Wake the coordinator on merged PRs","status":"todo","order":13,"milestone":"Coordinator automation","dependsOn":["p12"],"createdAt":1,"updatedAt":1},
                       {"id":"p14","number":14,"title":"Spike: coordinator memory","status":"todo","order":14,"createdAt":1,"updatedAt":1},
                       {"id":"p15","number":15,"title":"Rename milestones to phases in the tool","status":"done","order":15,"createdAt":1,"updatedAt":1}]},
             {"mission":{"id":"m6","projectId":"p1","title":"Small fixes","goal":"No phases.","status":"active","briefRevision":1,"createdAt":\(now - 172_800_000),"updatedAt":\(now)},
              "decisions":[],"comments":[],"artifacts":[],"resources":[],"events":[],
              "tasks":[{"id":"f1","number":1,"title":"Fix toolbar spacing","status":"done","order":1,"createdAt":1,"updatedAt":1},
                       {"id":"f2","number":2,"title":"Trim long chat titles","status":"todo","order":2,"createdAt":1,"updatedAt":1},
                       {"id":"f3","number":3,"title":"Faster tab switches","status":"in_progress","order":3,"createdAt":1,"updatedAt":1},
                       {"id":"f4","number":4,"title":"Old idea","status":"dropped","order":4,"createdAt":1,"updatedAt":1}]}]
            """
            guard let details = try? JSONDecoder().decode([MissionDetail].self, from: Data(json.utf8)),
                  let phaseDetails = try? JSONDecoder().decode([MissionDetail].self, from: Data(phasesJSON.utf8)) else {
                print("Invalid mission fixture")
                exit(1)
            }
            model.client.loadFixture(projects: Fixtures.projects, sessions: sessions)
            model.client.loadMissionFixture(details)
            model.selectedSessionId = nil
            model.showingInactiveMissions = true
            await render(SessionSidebar(model: model, client: model.client), size: CGSize(width: 300, height: 680),
                         to: directory.appending(path: "missions-sidebar.png"))
            model.openMission("m1")
            for tab in MissionTab.allCases {
                model.missionTab = tab
                await render(MissionPage(missionId: "m1"), size: CGSize(width: 1000, height: 900),
                             to: directory.appending(path: "mission-\(tab.rawValue).png"))
            }
            // Phases: a finished phase folded, active work first, "No phase" last and dropped tasks hidden.
            model.client.loadMissionFixture(details + phaseDetails)
            model.openMission("m5", tab: .tasks)
            await render(MissionPage(missionId: "m5"), size: CGSize(width: 1000, height: 1000),
                         to: directory.appending(path: "mission-tasks-phases.png"))
            // "Show task" on a dropped task in the folded phase unfolds it and shows dropped tasks.
            model.revealedMissionTaskId = "p4"
            await render(MissionPage(missionId: "m5"), size: CGSize(width: 1000, height: 1200),
                         to: directory.appending(path: "mission-tasks-phases-reveal.png"))
            // Without milestones, one flat list.
            model.openMission("m6", tab: .tasks)
            await render(MissionPage(missionId: "m6"), size: CGSize(width: 1000, height: 520),
                         to: directory.appending(path: "mission-tasks-flat.png"))
            model.client.loadMissionFixture(details)
            // Drafting: a new coordinator has not saved a goal, brief or task yet.
            model.openMission("m3")
            await render(MissionPage(missionId: "m3"), size: CGSize(width: 1000, height: 560),
                         to: directory.appending(path: "mission-drafting.png"))
            // Empty states: no coordinator, tasks, brief, chats, artifacts or activity.
            model.openMission("m4")
            for tab in MissionTab.allCases {
                model.missionTab = tab
                await render(MissionPage(missionId: "m4"), size: CGSize(width: 1000, height: 560),
                             to: directory.appending(path: "mission-empty-\(tab.rawValue).png"))
            }
            model.inspectorTab = .mission
            await render(MissionInspectorPane(session: sessions[1]), size: CGSize(width: 420, height: 700),
                         to: directory.appending(path: "mission-inspector.png"))
            await render(CreateMissionSheet(projectId: "p1", sourceSessionId: nil), size: CGSize(width: 500, height: 440),
                         to: directory.appending(path: "mission-new-sheet.png"))
            await render(CreateMissionSheet(projectId: nil, sourceSessionId: "solo"), size: CGSize(width: 500, height: 360),
                         to: directory.appending(path: "mission-make-sheet.png"))
            await render(StartCoordinatorSheet(missionId: "m4"), size: CGSize(width: 500, height: 380),
                         to: directory.appending(path: "mission-start-coordinator.png"))

            // The real window, so the toolbar title, section picker and actions are visible.
            model.openMission("m1")
            for _ in 0..<8 { try? await Task.sleep(for: .milliseconds(100)) }
            guard let window = NSApp.windows.first(where: { $0.toolbar != nil }),
                  let frame = window.contentView?.superview else {
                print("No native toolbar window available")
                exit(1)
            }
            window.setFrameOrigin(NSPoint(x: 100, y: 100))
            window.makeKeyAndOrderFront(nil)
            for (width, tab) in [(1360.0, MissionTab.overview), (1360.0, .tasks), (1360.0, .brief), (1360.0, .chats),
                                 (1360.0, .activity), (980.0, .overview)] {
                model.missionTab = tab
                window.setContentSize(CGSize(width: width, height: 860))
                for _ in 0..<8 { try? await Task.sleep(for: .milliseconds(100)) }
                snapshot(frame, to: directory.appending(path: "mission-window-\(tab.rawValue)-\(Int(width)).png"))
            }
            print("snapshots written to \(directory.path)")
            exit(0)
        }


        if CommandLine.arguments.contains("--tracking-only") {
            await renderTracking(model: model, to: directory)
            return
        }
        if CommandLine.arguments.contains("--slack-triage-only") {
            await renderSlackTriage(model: model, to: directory)
            NSApp.terminate(nil)
            return
        }
        if CommandLine.arguments.contains("--project-page-only") || CommandLine.arguments.contains("--sidebar-scope-only") {
            await renderProjectPages(model: model, to: directory)
            return
        }

        // Dense repository metadata must not push titles or timestamps out of narrow rows.
        model.client.loadFixture(projects: Fixtures.projects, sessions: Fixtures.sidebarLayoutSessions)
        model.client.handle(.missions([Fixtures.sidebarLayoutMission]))
        model.client.fixtureChangeSummaries = Dictionary(uniqueKeysWithValues: Fixtures.sidebarLayoutSessions
            .filter { $0.id != "layout-working" && $0.id != "layout-branch" }.map {
                ($0.id, SessionChangeSummary(base: "origin/main", branch: $0.branch, fileCount: 31,
                                            additions: $0.id == "layout-large" ? 123456 : 802,
                                            deletions: $0.id == "layout-large" ? 98765 : 143))
            })
        model.selectedSessionId = "layout-working"
        for width in [230, 280, 400] {
            await render(SessionSidebar(model: model, client: model.client),
                         size: CGSize(width: width, height: 560),
                         to: directory.appending(path: "sidebar-layout-\(width).png"))
        }
        model.client.handle(.missions([]))
        if CommandLine.arguments.contains("--sidebar-layout-only") {
            NSApp.terminate(nil)
            return
        }
        if CommandLine.arguments.contains("--subagents-only") {
            await renderSubagents(model: model, to: directory)
            NSApp.terminate(nil)
            return
        }
        model.client.loadFixture(projects: Fixtures.projects, sessions: Fixtures.sessions)
        model.client.fixtureChangeSummaries = Dictionary(uniqueKeysWithValues: Fixtures.sessions.map {
            ($0.id, SessionChangeSummary(base: "origin/main", branch: $0.branch, fileCount: $0.id == "s1" ? 2 : 0,
                                        additions: $0.id == "s1" ? 13 : 0, deletions: $0.id == "s1" ? 1 : 0))
        })

        if CommandLine.arguments.contains("--pr-icons-only") {
            model.client.loadFixture(projects: Fixtures.projects, sessions: Fixtures.pullRequestSessions)
            model.client.fixtureChangeSummaries = Dictionary(uniqueKeysWithValues: Fixtures.pullRequestSessions.map {
                ($0.id, SessionChangeSummary(base: "origin/main", branch: $0.branch, fileCount: 2, additions: 13, deletions: 1))
            })
            await render(SessionSidebar(model: model, client: model.client), size: CGSize(width: 280, height: 680),
                         to: directory.appending(path: "pr-sidebar-icons.png"))
            NSApp.terminate(nil)
            return
        }

        model.selectedSessionId = nil
        model.client.loadFixture(projects: Fixtures.projects, sessions: Fixtures.sessions + [
            SessionSummary(id: "status-idle", title: "Idle, ready for a task", cwd: Fixtures.projects[0].path, projectId: "p1",
                           createdAt: Fixtures.now, updatedAt: Fixtures.now, state: "idle"),
            SessionSummary(id: "status-stopped", title: "Stopped by you", cwd: Fixtures.projects[1].path, projectId: "p2",
                           createdAt: Fixtures.now, updatedAt: Fixtures.now, state: "idle", outcome: .stopped),
        ])
        await render(Frame(title: "Pilot", subtitle: nil) { HomeView() }, size: size, to: directory.appending(path: "status-icons.png"))
        model.client.loadFixture(projects: Fixtures.projects, sessions: Fixtures.sessions)
        await render(Frame(title: "Pilot", subtitle: nil) { HomeView() }, size: size, to: directory.appending(path: "home.png"))

        let savedDraftProject = model.draftProjectId
        model.draftProjectId = Fixtures.projects[0].id
        let branchScope = BranchSelectorState.scope(project: Fixtures.projects[0], mode: .build, workspace: nil)!
        let branchState = BranchSelectorState()
        await branchState.load(scope: branchScope) { model.client.fixtureBranches! }
        for branch in [nil, "feat/billing"] as [String?] {
            branchState.select(branch, for: branchScope)
            await render(
                VStack(spacing: 16) {
                    Text("What should Pilot work on?")
                        .font(.system(size: 24, weight: .semibold)).foregroundStyle(Theme.foreground)
                    TaskComposer(branches: branchState).frame(width: 640)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .padding(.top, 40).background(Theme.background),
                size: CGSize(width: 840, height: 320),
                to: directory.appending(path: branch == nil ? "branch-default.png" : "branch-selected.png")
            )
        }
        model.draftProjectId = savedDraftProject
        // Ask and Build use the same project/branch row, with a mode switch in the header.
        model.draftProjectId = Fixtures.projects[0].id
        for mode in [ChatMode.build, .ask] {
            let form = NewSessionForm()
            form.consumeDraft(from: model)
            form.mode = mode
            form.message = mode == .ask ? "Explain how durable sessions are resumed." : "Improve durable session resume handling."
            let state = BranchSelectorState()
            let scope = BranchSelectorState.scope(project: Fixtures.projects[0], mode: mode, workspace: nil)!
            await state.load(scope: scope, mode: mode) { model.client.fixtureBranches! }
            if mode == .ask { state.select("feat/billing", for: scope) }
            await render(TaskComposer(branches: state, form: form).frame(width: 680)
                .frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.background),
                size: CGSize(width: 840, height: 360),
                to: directory.appending(path: "new-chat-\(mode.rawValue).png"))
        }
        let askFixture = SessionSummary(id: "ask-source", title: "Explore durable session resume", cwd: Fixtures.projects[0].path,
                                        projectId: Fixtures.projects[0].id, createdAt: Fixtures.now, updatedAt: Fixtures.now,
                                        state: "idle", model: Fixtures.sessions[0].model, mode: .ask,
                                        sourceBranch: "feat/billing", sourceCommit: "abcdef0123456789")
        var askTranscript = Transcript()
        askTranscript.apply(try! JSONValue.decode(Data(#"""
        {"type":"snapshot","entries":[
          {"id":1,"kind":"pi.user","model":[{"role":"user","content":"Explain how durable sessions are resumed, and suggest an implementation plan."}]},
          {"id":2,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"read-source","name":"read","arguments":{"path":"packages/daemon/src/sessions.ts"}}]}]},
          {"id":3,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":"read-source","toolName":"read","content":[{"type":"text","text":"Session registry retains durable history and resumes workers on demand."}],"isError":false}]},
          {"id":4,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"text","text":"The daemon retains the conversation and resumes the worker on demand. A parked session does not lose its history.\n\n### Suggested plan\n1. Check the last settled run before starting a worker.\n2. Recover interrupted operations without replaying unsafe writes.\n3. Add regression tests for reconnect and resume.\n\nThis Ask chat is read-only. Start a separate Build chat when you are ready to implement the plan."}]}]}
        ],"tools":[],"inbox":[]}
        """#.utf8)))
        let askFeed = SessionFeed(sessionId: askFixture.id, transcript: askTranscript)
        await render(Frame(title: askFixture.title, subtitle: "pilot", session: askFixture) {
            ChatView(session: askFixture, feed: askFeed)
        }, size: size, to: directory.appending(path: "ask-chat.png"))
        model.draftProjectId = savedDraftProject
        if CommandLine.arguments.contains("--ask-build-only") {
            NSApp.terminate(nil)
            return
        }
        if CommandLine.arguments.contains("--branches-only") {
            NSApp.terminate(nil)
            return
        }

        // A short sidebar forces session rows beneath the fixed connection footer.
        for width in [230, 280] {
            await render(
                SessionSidebar(model: model, client: model.client),
                size: CGSize(width: width, height: 360),
                to: directory.appending(path: "sidebar-footer-\(width).png")
            )
        }

        // Exercise grouped, ungrouped and empty folders, then search through saved collapse state.
        let savedFolders = model.projectFolders
        model.projectFolders = ProjectFolders()
        let work = model.projectFolders.create(name: "Work")!
        model.projectFolders.move(projectId: "p1", to: work.id)
        _ = model.projectFolders.create(name: "Ideas")
        await render(Frame(title: "Pilot", subtitle: nil) { HomeView() }, size: size,
                     to: directory.appending(path: "sidebar-folders.png"))
        model.projectFolders.setExpanded(false, folderId: work.id)
        await render(Frame(title: "Pilot", subtitle: nil) { HomeView() }, size: size,
                     to: directory.appending(path: "sidebar-folders-collapsed.png"))
        model.sidebarQuery = "flaky"
        await render(Frame(title: "Pilot", subtitle: nil) { HomeView() }, size: size,
                     to: directory.appending(path: "sidebar-folders-search.png"))
        model.sidebarQuery = ""
        model.projectFolders = savedFolders
        if CommandLine.arguments.contains("--sidebar-folders-only") {
            NSApp.terminate(nil)
            return
        }

        await render(
            VStack(spacing: 16) {
                Text("What should Pilot work on?")
                    .font(.system(size: 24, weight: .semibold)).foregroundStyle(Theme.foreground)
                TaskComposer().frame(width: 640)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .padding(.top, 40).background(Theme.background),
            size: CGSize(width: 840, height: 500),
            to: directory.appending(path: "path-completion.png"),
            completionPreview: true
        )

        // Typing "/" opens the slash command menu: Pilot's built-ins, then prompt templates and skills.
        await render(
            VStack {
                Spacer()
                Composer(
                    state: ComposerState(), working: false, queuedMessages: [], completionDirectory: nil,
                    onSend: { _, _ in }, onStop: {}, onEditQueuedMessage: { _, _, _ in }, onRemoveQueuedMessage: { _ in },
                    slashCommands: SlashCommands.all([
                        SessionCommand(name: "review", source: .prompt, description: "Review the current diff for bugs and risky changes",
                                       argumentHint: "<focus>"),
                        SessionCommand(name: "changelog", source: .prompt, description: "Draft release notes from merged changes"),
                        SessionCommand(name: "skill:commit", source: .skill,
                                       description: "Create a conventional jj commit and, when requested, push a relevant or inferred bookmark."),
                        SessionCommand(name: "skill:pilot-artifacts", source: .skill,
                                       description: "Author, publish, or update offline HTML, React, image, and SwiftUI artifacts."),
                    ])
                )
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.background),
            size: CGSize(width: 840, height: 560),
            to: directory.appending(path: "slash-completion.png"),
            completionPreview: true, completionText: "/"
        )
        if CommandLine.arguments.contains("--completion-only") {
            NSApp.terminate(nil)
            return
        }

        let session = Fixtures.sessions[0]
        model.selectedSessionId = session.id
        let feed = SessionFeed(sessionId: session.id, transcript: Fixtures.transcript)
        await render(
            Frame(title: session.title, subtitle: "pilot · \(session.model ?? "")", session: session) {
                ChatView(session: session, feed: feed)
            },
            size: size,
            to: directory.appending(path: "session-debug-button.png")
        )
        model.debugSession(session)
        model.draftMessage? += "The tool call stopped returning output. Investigate why and fix the issue."
        await render(Frame(title: "Pilot", subtitle: nil) { HomeView() }, size: size,
                     to: directory.appending(path: "session-debug-draft.png"), scrollEditorToEnd: true)
        model.selectedSessionId = session.id
        await render(
            Frame(title: session.title, subtitle: "pilot", session: session) {
                ChatView(session: session, feed: feed)
            },
            size: size,
            to: directory.appending(path: "session.png")
        )
        model.client.fixtureChanges = Fixtures.changes
        await render(
            Frame(title: session.title, subtitle: "pilot") {
                ChatView(session: session, feed: SessionFeed(sessionId: session.id, transcript: Fixtures.queuedTranscript))
            },
            size: size,
            to: directory.appending(path: "session-queued.png")
        )
        await render(
            Frame(title: session.title, subtitle: "pilot") {
                ChatView(session: session, feed: SessionFeed(sessionId: session.id, transcript: Fixtures.longQueuedTranscript))
            },
            size: CGSize(width: 1000, height: 700),
            to: directory.appending(path: "session-long-queue.png")
        )
        await render(
            Frame(title: session.title, subtitle: "pilot") {
                ChatView(session: session, feed: SessionFeed(sessionId: session.id, transcript: Fixtures.systemMessagesTranscript))
            },
            size: size,
            to: directory.appending(path: "session-system-messages.png")
        )
        await render(
            SystemMessagesStrip(inputs: PendingAutomaticInput.inDeliveryOrder(
                Fixtures.systemMessagesTranscript.automaticInputs), expanded: true)
                .padding(4).frame(width: 640).background(Theme.tray),
            size: CGSize(width: 640, height: 150),
            to: directory.appending(path: "system-messages-expanded.png")
        )
        await render(
            SystemMessagesStrip(inputs: Fixtures.systemMessagesTranscript.automaticInputs.prefix(2).map {
                PendingAutomaticInput(id: $0.id, origin: $0.origin, mode: $0.mode, preview: $0.preview,
                                      queuedAt: $0.queuedAt, held: true)
            }, expanded: true, onSendHeld: {}, onDiscardHeld: {})
                .padding(4).frame(width: 640).background(Theme.tray),
            size: CGSize(width: 640, height: 110),
            to: directory.appending(path: "system-messages-held.png")
        )
        model.inspectorVisible = true
        let editingComposer = ComposerState()
        editingComposer.selectQueuedMessage(Fixtures.queuedTranscript.queuedMessages[0])
        await render(
            Frame(title: session.title, subtitle: "pilot") {
                ChatView(session: session,
                         feed: SessionFeed(sessionId: session.id, transcript: Fixtures.queuedTranscript),
                         composer: editingComposer)
            },
            size: size,
            to: directory.appending(path: "queued-message-editor.png")
        )
        model.inspectorTab = .changes
        await render(
            Frame(title: session.title, subtitle: "pilot · \(session.branch ?? "")") {
                HStack(spacing: 0) {
                    ChatView(session: session, feed: SessionFeed(sessionId: session.id, transcript: Fixtures.transcript))
                    Rectangle().fill(Theme.border).frame(width: 1)
                    Inspector(session: session).frame(width: 520)
                }
            },
            size: CGSize(width: 1500, height: 860),
            to: directory.appending(path: "session-changes.png")
        )
        await render(SettingsView().environmentObject(model), size: CGSize(width: 780, height: 580), to: directory.appending(path: "settings.png"))
        await render(
            VStack(alignment: .leading, spacing: 16) {
                SubscriptionUsageNotice(usage: SessionUsage(subscription: SubscriptionUsage(
                    fetchedAt: Date().timeIntervalSince1970 * 1_000, provider: .anthropic,
                    windows: [SubscriptionWindow(label: "5h", usedPercent: 86,
                                                 resetsAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(7_200)))])))
                SubscriptionUsageNotice(usage: SessionUsage(subscription: SubscriptionUsage(
                    fetchedAt: Date().timeIntervalSince1970 * 1_000, provider: .openai,
                    windows: [SubscriptionWindow(label: "Week", usedPercent: 100)])))
                HStack(spacing: 16) {
                    ContextUsageIndicator(usage: Fixtures.codexUsage)
                    ContextUsageIndicator(usage: Fixtures.claudeUsage)
                    ContextUsageIndicator(usage: SessionUsage(context: ContextUsage(contextWindow: 200_000)))
                }
                .padding(.horizontal, 10)
                SubscriptionUsageBars(subscriptions: [Fixtures.claudeUsage.subscription!, Fixtures.codexUsage.subscription!],
                                      now: Date(timeIntervalSince1970: Fixtures.now / 1000))
                    .padding(.horizontal, 10)
            }
            .padding(.vertical, 16)
            .background(Theme.background),
            size: CGSize(width: 760, height: 200),
            to: directory.appending(path: "usage-indicators.png")
        )
        for width in [760, 420] {
            await render(
                Composer(
                    state: ComposerState(), working: true, queuedMessages: [],
                    completionDirectory: session.cwd,
                    onSend: { _, _ in }, onStop: {}, onEditQueuedMessage: { _, _, _ in },
                    onRemoveQueuedMessage: { _ in },
                    session: session
                )
                .padding(.top, 16)
                .background(Theme.background),
                size: CGSize(width: width, height: 200),
                to: directory.appending(path: width == 760 ? "usage-composer.png" : "usage-composer-narrow.png")
            )
        }
        do {
            let image = PlaneImage.menuBar
            let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 72, pixelsHigh: 72, bitsPerSample: 8,
                                       samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                       bytesPerRow: 0, bitsPerPixel: 0)!
            rep.size = image.size
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
            image.draw(in: NSRect(origin: .zero, size: image.size))
            NSGraphicsContext.restoreGraphicsState()
            try? rep.representation(using: .png, properties: [:])?.write(to: directory.appending(path: "menubar.png"))
        }
        for session in Fixtures.sessions where session.outcome == .done {
            model.selectedSessionId = session.id
            await render(
                Frame(title: session.title, subtitle: "pilot", status: session.status, session: session) {
                    ChatView(session: session, feed: SessionFeed(sessionId: session.id, transcript: Fixtures.settledTranscript(text: session.id == "s5" ? Fixtures.questionText : Fixtures.completionText)))
                },
                size: size,
                to: directory.appending(path: session.id == "s5" ? "done-question-unread.png" : "done-unread.png")
            )
        }
        let finishedAt = Date().timeIntervalSince1970 * 1_000
        let prioritySessions: [SessionSummary] = [
            SessionSummary(id: "priority-closed", title: "Closed PR, no attention", cwd: Fixtures.projects[0].path,
                           projectId: "p1", createdAt: finishedAt - 86_400_000, updatedAt: finishedAt,
                           state: "idle", outcome: .done, outcomeAt: finishedAt,
                           pullRequest: SessionPullRequest(number: 5, url: "https://github.com/babariviere/pilot/pull/5",
                                                          title: "Closed work", state: .closed, checkedAt: finishedAt)),
            SessionSummary(id: "priority-working", title: "Still working", cwd: Fixtures.projects[0].path,
                           projectId: "p1", createdAt: finishedAt - 3_600_000, updatedAt: finishedAt - 120_000,
                           state: "working"),
            SessionSummary(id: "priority-finished", title: "Just finished, ready to review", cwd: Fixtures.projects[0].path,
                           projectId: "p1", createdAt: finishedAt - 3_600_000, updatedAt: finishedAt - 3_600_000,
                           state: "idle", outcome: .done, outcomeAt: finishedAt),
            SessionSummary(id: "priority-merged", title: "Merged PR, no attention", cwd: Fixtures.projects[0].path,
                           projectId: "p1", createdAt: finishedAt - 86_400_000, updatedAt: finishedAt,
                           state: "idle", outcome: .done, outcomeAt: finishedAt,
                           pullRequest: SessionPullRequest(number: 4, url: "https://github.com/babariviere/pilot/pull/4",
                                                          title: "Merged work", state: .merged, checkedAt: finishedAt)),
        ]
        model.client.loadFixture(projects: Fixtures.projects, sessions: prioritySessions)
        model.selectedSessionId = nil
        await render(Frame(title: "Pilot", subtitle: nil) { HomeView() }, size: size,
                     to: directory.appending(path: "thread-priority.png"))
        // A separate fixture set preserves the original attention/usage/diff screenshots.
        model.client.loadFixture(projects: Fixtures.projects, sessions: Fixtures.pullRequestSessions)
        model.client.fixtureChangeSummaries = Dictionary(uniqueKeysWithValues: Fixtures.pullRequestSessions.map {
            ($0.id, SessionChangeSummary(base: "origin/main", branch: $0.branch ?? "pilot/\($0.id)",
                                        fileCount: $0.id == "pr-merged" ? 0 : 2,
                                        additions: $0.id == "pr-merged" ? 0 : 13,
                                        deletions: $0.id == "pr-merged" ? 0 : 1))
        })
        model.inspectorVisible = false
        model.selectedSessionId = nil
        await render(Frame(title: "Pilot", subtitle: nil) { HomeView() }, size: size, to: directory.appending(path: "pr-dashboard.png"))
        for session in Fixtures.pullRequestSessions where ["pr-open", "pr-merged", "pr-stale"].contains(session.id) {
            model.selectedSessionId = session.id
            await render(
                Frame(title: session.title, subtitle: "pilot · \(session.model ?? "default model")", status: session.status, session: session) {
                    ChatView(session: session, feed: SessionFeed(sessionId: session.id, transcript: session.isWorking ? Fixtures.transcript : Fixtures.settledTranscript()))
                },
                size: size,
                to: directory.appending(path: "\(session.id).png")
            )
        }
        print("snapshots written to \(directory.path)")
        exit(0)
    }

    /// Project page states with fixture dashboards: populated, long content, quiet, new, loading and errors,
    /// plus the real window so the toolbar title, New chat and actions menu are visible.

    private static func renderMissionLinks(model: AppModel, to directory: URL) async {
        let now = Fixtures.now
        let hour = 3_600_000.0
        func resource(_ id: String, _ url: String, _ kind: String, task: String? = nil, title: String? = nil,
                      externalId: String? = nil, pr: String? = nil, at: Double = 1) -> String {
            var fields = ["\"id\":\"\(id)\"", "\"url\":\"\(url)\"", "\"kind\":\"\(kind)\"", "\"createdAt\":\(at)"]
            if let task { fields.append("\"taskId\":\"\(task)\"") }
            if let title { fields.append("\"title\":\"\(title)\"") }
            if let externalId { fields.append("\"externalId\":\"\(externalId)\"") }
            if let pr { fields.append("\"pullRequest\":\(pr)") }
            return "{" + fields.joined(separator: ",") + "}"
        }
        func pullRequest(_ number: Int, _ title: String, _ state: String, merged: Double? = nil) -> String {
            let url = "https://github.com/acme/pilot/pull/\(number)"
            let mergedAt = merged.map { ",\"mergedAt\":\($0)" } ?? ""
            return "{\"number\":\(number),\"url\":\"\(url)\",\"title\":\"\(title)\",\"state\":\"\(state)\",\"checkedAt\":\(now)\(mergedAt)}"
        }
        func prLink(_ number: Int, _ title: String, _ state: String, task: Int?, merged: Double? = nil) -> String {
            resource("pr\(number)", "https://github.com/acme/pilot/pull/\(number)", "github.pr",
                     task: task.map { "t\($0)" }, externalId: "acme/pilot#\(number)",
                     pr: pullRequest(number, title, state, merged: merged), at: now - Double(1_000 - number) * hour / 10)
        }
        var links = [
            resource("lp", "https://linear.app/acme/project/missions-0123456789ab", "linear.project",
                     title: "Missions: shared goals across chats", externalId: "missions-0123456789ab"),
            resource("li1", "https://linear.app/acme/issue/PIL-142", "linear.issue", task: "t3",
                     title: "Restack dependent pull requests in one step", externalId: "PIL-142", at: 2),
            resource("li2", "https://linear.app/acme/issue/PIL-138", "linear.issue", task: "t4",
                     title: "Mission tabs freeze when switching", externalId: "PIL-138", at: 3),
            resource("li3", "https://linear.app/acme/issue/PIL-151/overview-link-groups", "linear.issue", task: "t5",
                     externalId: "PIL-151", at: 4),
            resource("li4", "https://linear.app/acme/issue/PIL-120", "linear.issue", task: "t1",
                     title: "Share the brief between chats", externalId: "PIL-120", at: 5),
            resource("li5", "https://linear.app/acme/issue/PIL-121", "linear.issue", task: "t2",
                     title: "Decisions override the brief", externalId: "PIL-121", at: 6),
            resource("li6", "https://linear.app/acme/issue/PIL-122", "linear.issue", task: "t2",
                     title: "Needs-you counts in the sidebar", externalId: "PIL-122", at: 7),
            resource("s1", "https://acme.slack.com/archives/C1/p1111111111111111", "slack.thread",
                     title: "#pilot-dev thread"),
            resource("g1", "https://github.com/acme/pilot/issues/31", "github.issue", task: "t6", externalId: "acme/pilot#31"),
            resource("u1", "https://gist.github.com/acme/optchat", "url", title: "OptChat gist"),
            resource("u2", "https://docs.example.com/gh-stack", "url", title: "gh-stack docs"),
            // A pull request whose state was never looked up is not guessed to be open.
            resource("pr-unknown", "https://github.com/acme/pilot/pull/96", "github.pr", title: "Dedicated new chat",
                     externalId: "acme/pilot#96"),
            prLink(212, "perf(macos): build mission rows lazily", "draft", task: 4),
            prLink(210, "feat(macos): group links by provider", "open", task: 5),
            prLink(209, "feat(macos): show GitHub, Linear and Slack marks for links", "open", task: 6),
        ]
        let mergedTitles = [
            "feat(macos): redesign mission pages as calm status views", "feat(artifacts): expose parent-scoped tools to subagents",
            "feat(artifacts): read authorized linked cross-chat sources", "Refresh shared workspace bases safely between turns",
            "fix(macos): reject failed native test target summaries", "test(daemon): stabilize start reference assertions",
            "feat(chats): start a planning chat from creation forms", "fix(daemon): omit self-originated and stale settle updates",
            "fix: bound test concurrency by default", "feat: track pull request stack positions",
            "feat: add task deletion, ordering and bulk grouping", "feat(daemon): deliver durable batched event notices",
        ]
        for (index, title) in mergedTitles.enumerated() {
            let number = 203 - index
            links.append(prLink(number, title, "merged", task: 1 + index % 6, merged: now - Double(index + 1) * 5 * hour))
        }
        for (index, number) in [180, 176, 171, 160].enumerated() {
            links.append(prLink(number, "Abandoned approach \(index + 1)", "closed", task: index + 1))
        }
        // The same pull request linked from the mission and from a task shows once, with its task.
        links.append(resource("pr210-mission", "https://github.com/acme/pilot/pull/210", "github.pr", externalId: "acme/pilot#210",
                              pr: pullRequest(210, "feat(macos): group links by provider", "open"),
                              at: now - 790 * hour / 10))
        let tasks = (1...6).map { number in
            "{\"id\":\"t\(number)\",\"number\":\(number + 66),\"title\":\"Task \(number + 66)\",\"status\":\"\(number < 3 ? "done" : "in_progress")\",\"order\":\(number),\"createdAt\":1,\"updatedAt\":1}"
        }.joined(separator: ",")
        let json = """
        [{"mission":{"id":"ml","projectId":"p1","title":"Pilot Mission","goal":"Share a goal across chats.","status":"active","briefRevision":1,"createdAt":\(now),"updatedAt":\(now)},
          "decisions":[],"comments":[],"tasks":[\(tasks)],"artifacts":[],"resources":[\(links.joined(separator: ","))],"events":[]},
         {"mission":{"id":"mn","projectId":"p1","title":"Quiet mission","goal":"No links.","status":"active","briefRevision":1,"createdAt":\(now),"updatedAt":\(now)},
          "decisions":[],"comments":[],"tasks":[],"artifacts":[],"resources":[],"events":[]},
         {"mission":{"id":"mo","projectId":"p1","title":"Few links","goal":"A little.","status":"active","briefRevision":1,"createdAt":\(now),"updatedAt":\(now)},
          "decisions":[],"comments":[],"tasks":[],"artifacts":[],"events":[],"resources":[\(links.prefix(3).joined(separator: ",")),\(links[11]),\(links[13])]}]
        """
        guard let details = try? JSONDecoder().decode([MissionDetail].self, from: Data(json.utf8)) else {
            print("Invalid mission link fixture")
            exit(1)
        }
        model.client.loadFixture(projects: Fixtures.projects, sessions: [])
        model.client.loadMissionFixture(details)
        let full = details[0]
        model.openMission("ml")
        model.missionTab = .overview
        await render(MissionPage(missionId: "ml"), size: CGSize(width: 1000, height: 1500),
                     to: directory.appending(path: "mission-links-overview.png"))
        func section(_ detail: MissionDetail, width: CGFloat = 720, expanded: Bool = false) -> some View {
            MissionLinksSection(mission: detail.mission, detail: detail, expanded: expanded)
                .padding(24).frame(width: width, alignment: .leading).frame(maxHeight: .infinity, alignment: .top)
                .background(Theme.background)
        }
        await render(section(full), size: CGSize(width: 720, height: 520), to: directory.appending(path: "mission-links-default.png"))
        await render(section(full, expanded: true),
                     size: CGSize(width: 720, height: 2400), to: directory.appending(path: "mission-links-expanded.png"))
        await render(section(details[2]), size: CGSize(width: 720, height: 380), to: directory.appending(path: "mission-links-few.png"))
        await render(section(details[1]), size: CGSize(width: 720, height: 160), to: directory.appending(path: "mission-links-empty.png"))
        await render(section(full, width: 440), size: CGSize(width: 440, height: 520), to: directory.appending(path: "mission-links-narrow.png"))
    }

    /// Tracked items inbox, its states, the ticket-prefilled composer and mission sheet, and Tracking settings.
    /// Synthetic data only.
    private static func renderTracking(model: AppModel, to directory: URL) async {
        let now = Fixtures.now
        let minute = 60_000.0
        let day = 24 * 60 * minute
        let home = Fixtures.home
        let tracking = ProjectTrackingConfig(
            slackChannels: ["C0BUGS0001", "C0SUPPORT2", "C0QAREPRT3"],
            slackChannelNames: ["C0BUGS0001": "bugs", "C0SUPPORT2": "support-escalations", "C0QAREPRT3": "qa-reports"],
            linearTeam: "team-platform", linearTeamName: "Platform")
        let projects = [
            Project(id: "p1", name: "pilot", path: "\(home)/src/github.com/babariviere/pilot", tracking: tracking,
                    createdAt: now),
            Project(id: "p2", name: "dotfiles", path: "\(home)/src/github.com/babariviere/dotfiles", createdAt: now),
        ]
        func session(_ id: String, _ title: String, state: String = "idle", outcome: SessionOutcome? = nil,
                     pr: Int? = nil) -> SessionSummary {
            SessionSummary(id: id, title: title, cwd: projects[0].path, projectId: "p1", createdAt: now - 30 * minute,
                           updatedAt: now - 5 * minute, state: state, outcome: outcome, outcomeAt: now - 5 * minute,
                           pullRequest: pr.map {
                               SessionPullRequest(number: $0, url: "https://github.com/babariviere/pilot/pull/\($0)",
                                                  title: "fix: currency", state: .open, checkedAt: now)
                           })
        }
        model.client.loadFixture(projects: projects, sessions: [
            session("w1", "ENG-412 export crash", state: "working"),
            session("f1", "Flaky workspace lifecycle test", outcome: .failed),
            session("d1", "Archive shortcut", outcome: .done),
            session("pr1", "Swiss invoice currency", outcome: .done, pr: 431),
        ])
        let missionJSON = """
        [{"mission":{"id":"m1","projectId":"p1","title":"Keyboard shortcuts pass","goal":"","status":"active",
        "briefRevision":1,"createdAt":\(now),"updatedAt":\(now)},"decisions":[],"comments":[],"tasks":[],
        "artifacts":[],"resources":[],"events":[]}]
        """
        if let missions = try? JSONDecoder().decode([MissionDetail].self, from: Data(missionJSON.utf8)) {
            model.client.loadMissionFixture(missions)
        }
        // Read, then left: these results have moved out of Needs you.
        for id in ["d1", "pr1"] {
            if let session = model.client.session(id) { model.attention.review(session, chatVisible: true, appActive: true) }
        }
        model.leaveOpenChat()
        func linear(_ number: Int, _ title: String, _ type: String, _ state: String, priority: Double, ago: Double,
                    sessions: [String]? = nil, missions: [String]? = nil, startFailed: Bool = false) -> TrackedItem {
            var metadata: [String: JSONValue] = ["identifier": .string("ENG-\(number)"), "statusType": .string(type),
                                                 "priority": .number(priority)]
            if startFailed {
                metadata["linearStart"] = .object(["outcome": .string("error"), "attemptedAt": .number(now - ago),
                                                   "error": .string("Couldn't move ticket to In progress.")])
            }
            return TrackedItem(id: "l\(number)", projectId: "p1", kind: .linear, externalId: "uuid-\(number)", title: title,
                        url: "https://linear.app/acme/issue/ENG-\(number)", status: state,
                        metadata: metadata,
                        sessionId: sessions?.last, missionId: missions?.last, sessionIds: sessions, missionIds: missions,
                        createdAt: now - ago, updatedAt: now - ago)
        }
        func slack(_ id: String, _ title: String, channel: String, severity: String, ago: Double,
                   sessions: [String]? = nil) -> TrackedItem {
            TrackedItem(id: id, projectId: "p1", kind: .slack, externalId: "C/\(id)", title: title,
                        url: "https://slack.com/archives/C0BUGS0001/p1791892800000001", status: "open",
                        metadata: ["channelName": .string(channel), "severity": .string(severity)],
                        sessionId: sessions?.last, sessionIds: sessions, createdAt: now - ago, updatedAt: now - ago)
        }
        let items = [
            linear(412, "Export crashes when a quote has more than 200 lines", "started", "In Progress", priority: 1,
                   ago: 20 * minute, sessions: ["w1"]),
            linear(418, "Retry webhook delivery after a 502 from the billing provider", "started", "In Review",
                   priority: 2, ago: 3 * 60 * minute),
            linear(388, "Flaky test: workspace lifecycle does not settle", "unstarted", "Todo", priority: 2,
                   ago: 5 * 60 * minute, sessions: ["f1"]),
            linear(397, "Add a keyboard shortcut to archive a chat", "unstarted", "Todo", priority: 3, ago: day,
                   sessions: ["d1"], missions: ["m1"], startFailed: true),
            linear(420, "Settings window forgets its size between launches", "backlog", "Backlog", priority: 4,
                   ago: 2 * day),
            linear(371, "Upgrade the daemon to Node 24", "completed", "Done", priority: 3, ago: 3 * day),
            linear(366, "Document the release process", "completed", "Done", priority: 0, ago: 4 * day),
            slack("s1", "Checkout button does nothing on Safari 18", channel: "bugs", severity: "high", ago: 12 * minute),
            slack("s2", "Invoices show the wrong currency for Swiss customers", channel: "support-escalations",
                  severity: "medium", ago: 2 * 60 * minute, sessions: ["pr1"]),
            slack("s3", "Login loops back to the sign-in page after a password reset", channel: "bugs",
                  severity: "critical", ago: day),
        ]
        let iso = ISO8601DateFormatter()
        let cycle = LinearCycleSummary(id: "c42", number: 42,
                                       startsAt: iso.string(from: Date(timeIntervalSince1970: (now - 7 * day) / 1000)),
                                       endsAt: iso.string(from: Date(timeIntervalSince1970: (now + 6 * day) / 1000)),
                                       progress: 2 / 7, total: 7, done: 2, inProgress: 2, todo: 3)
        let linearSource = TrackingSource(
            id: "p1:linear", projectId: "p1", kind: .linear, label: "Linear", configured: true, status: .ok,
            lastPolledAt: now - 3 * minute, linear: LinearSourceSummary(cycleStatus: .current, currentCycle: cycle))
        let slackSource = TrackingSource(
            id: "p1:slack", projectId: "p1", kind: .slack, label: "Slack", configured: true, status: .error,
            lastPolledAt: now - 4 * minute,
            error: "A Slack channel could not be read. Check its access in project settings.",
            channels: [
                SlackChannelStatus(id: "C0BUGS0001", name: "bugs", status: .ok, lastPulledAt: now - 4 * minute),
                SlackChannelStatus(id: "C0SUPPORT2", name: "support-escalations", status: .ok,
                                   lastPulledAt: now - 9 * minute),
                SlackChannelStatus(id: "C0QAREPRT3", name: "qa-reports", status: .error,
                                   error: "Couldn't read this channel. Check that you can open it in Slack."),
            ])
        let channels = TrackingLookup(status: .ok, items: [
            SlackChannelOption(id: "C0GENERAL1", name: "general"),
            SlackChannelOption(id: "C0BUGS0001", name: "bugs"),
            SlackChannelOption(id: "G0INCIDNT1", name: "incidents", isPrivate: true),
            SlackChannelOption(id: "C0RELEASE1", name: "releases"),
        ])
        model.client.loadTrackingFixture(TrackingFixture(
            sources: [linearSource, slackSource], items: items,
            teams: TrackingLookup(status: .ok, items: [
                LinearTeamOption(id: "team-root", name: "Engineering", key: "ENG"),
                LinearTeamOption(id: "team-platform", name: "Platform", key: "PLT", parentId: "team-root"),
                LinearTeamOption(id: "team-web", name: "Web", key: "WEB", parentId: "team-root"),
            ]),
            myChannels: channels, searchChannels: channels))
        let inbox = TrackedInboxSheet(project: projects[0], openSettings: {}) { _ in }
        await render(inbox, size: CGSize(width: 680, height: 1000), to: directory.appending(path: "tracked-inbox.png"))

        // Sign-in required for Linear, an empty Slack page, and a project that tracks nothing.
        model.client.loadTrackingFixture(TrackingFixture(
            sources: [
                TrackingSource(id: "p1:linear", projectId: "p1", kind: .linear, label: "Linear", configured: true,
                               status: .signInRequired, error: "Sign in required", signInCommand: "pi mcp login linear"),
                TrackingSource(id: "p1:slack", projectId: "p1", kind: .slack, label: "Slack", configured: true,
                               status: .ok, lastPolledAt: now - minute, channels: slackSource.channels),
            ], items: []))
        await render(TrackedInboxSheet(project: projects[0], openSettings: {}) { _ in },
                     size: CGSize(width: 680, height: 420), to: directory.appending(path: "tracked-inbox-signin.png"))
        await render(TrackedInboxSheet(project: projects[1], openSettings: {}) { _ in },
                     size: CGSize(width: 680, height: 420), to: directory.appending(path: "tracked-inbox-empty.png"))

        // Settings: team picker, channels with per-channel status (one added but not saved yet).
        model.client.loadTrackingFixture(TrackingFixture(
            sources: [linearSource, slackSource], items: items,
            teams: TrackingLookup(status: .ok, items: [
                LinearTeamOption(id: "team-platform", name: "Platform", key: "PLT"),
            ]),
            myChannels: channels, searchChannels: channels))
        let editor = ProjectEditor()
        editor.load(projects[0])
        editor.addChannel(SlackChannelOption(id: "G0INCIDNT1", name: "incidents", isPrivate: true))
        await render(Form { TrackingSettingsSection(project: projects[0], editor: editor) }.formStyle(.grouped),
                     size: CGSize(width: 560, height: 520), to: directory.appending(path: "tracking-settings.png"))
        await render(Form { TrackingSettingsSection(project: projects[0], editor: editor, channelQuery: "re") }
            .formStyle(.grouped),
                     size: CGSize(width: 560, height: 640), to: directory.appending(path: "tracking-settings-search.png"))

        // Settings while signed out of Linear, and while Slack waits for the browser.
        let slackWaiting = SourceSignIn(kind: .slack, state: .waiting, again: true, startedAt: now - 20_000,
                                        expiresAt: now + 280_000)
        model.client.loadTrackingFixture(TrackingFixture(
            sources: [
                TrackingSource(id: "p1:linear", projectId: "p1", kind: .linear, label: "Linear", configured: true,
                               status: .signInRequired, error: "Sign in required", signInCommand: "pi mcp login linear"),
                TrackingSource(id: "p1:slack", projectId: "p1", kind: .slack, label: "Slack", configured: true,
                               status: .ok, lastPolledAt: now - minute, channels: slackSource.channels,
                               signIn: slackWaiting),
            ], items: [],
            teams: TrackingLookup(status: .signInRequired, error: "Sign in required", signInCommand: "pi mcp login linear"),
            myChannels: channels, searchChannels: channels))
        await render(Form { TrackingSettingsSection(project: projects[0], editor: editor) }.formStyle(.grouped),
                     size: CGSize(width: 560, height: 560), to: directory.appending(path: "tracking-settings-signin.png"))

        // The project page's Current cycle and Tracked sections: live rows, no cycle, sign-in and nothing attached.
        func row(_ item: TrackedItem) -> DashboardTrackedItem {
            DashboardTrackedItem(id: item.id, title: item.title, url: item.url, status: item.status,
                                 updatedAt: item.updatedAt, externalId: item.externalId, metadata: item.metadata,
                                 sessionId: item.sessionId, missionId: item.missionId, sessionIds: item.sessionIds,
                                 missionIds: item.missionIds)
        }
        let longIssue = linear(431, "Quotes with more than two hundred line items time out while exporting to PDF and "
            + "the retry silently drops the attachments", "unstarted", "Todo", priority: 2, ago: 40 * minute)
        let openIssues = [items[0], items[1], longIssue, items[2], items[3]]
        let doneIssues = [items[5], items[6]]
        let reports = Array(items[7...9])
        func pageDashboard(_ projectId: String, tracked: [DashboardTrackedSource]) -> ProjectDashboard {
            ProjectDashboard(
                projectId: projectId,
                summary: ProjectDashboardSummary(chats: 4, working: 1, needsYou: 1),
                needsYou: DashboardSection(total: 1, items: [
                    DashboardNeedsYouItem(kind: .failed, id: "session:f1", title: "Flaky workspace lifecycle test",
                                          sessionId: "f1", outcome: .failed, reason: "workspace lifecycle did not settle",
                                          at: now - 5 * minute),
                ]),
                working: DashboardSection(total: 1, items: [
                    DashboardWorkingItem(sessionId: "w1", title: "ENG-412 export crash", model: "anthropic/claude-opus-5-5",
                                         branch: "eng-412-export-crash", startedAt: now - 20 * minute),
                ]),
                tracked: tracked)
        }
        let cycleGroup = DashboardTrackedSource(
            source: "linear", label: "Linear", status: .ok, total: 7, items: openIssues.map(row),
            done: DashboardSection(total: 2, items: doneIssues.map(row)), linear: linearSource.linear)
        let slackGroup = DashboardTrackedSource(source: "slack", label: "Slack", status: .error, error: slackSource.error,
                                                total: 9, items: reports.map(row))
        model.client.loadTrackingFixture(TrackingFixture(sources: [linearSource, slackSource], items: items))
        model.client.loadDashboardFixture([pageDashboard("p1", tracked: [cycleGroup, slackGroup])])
        await render(ProjectPage(projectId: "p1"), size: CGSize(width: 900, height: 1180),
                     to: directory.appending(path: "project-tracking.png"))

        // No active cycle: my open issues in the team. Slack synced with nothing found.
        let noCycle = LinearSourceSummary(cycleStatus: .noActiveCycle,
                                          statusMessage: "Cycles are disabled or no cycle is active. Showing your open issues.")
        let quietSlack = TrackingSource(id: "p1:slack", projectId: "p1", kind: .slack, label: "Slack", configured: true,
                                        status: .ok, lastPolledAt: now - minute, channels: slackSource.channels)
        model.client.loadTrackingFixture(TrackingFixture(sources: [
            TrackingSource(id: "p1:linear", projectId: "p1", kind: .linear, label: "Linear", configured: true,
                           status: .ok, lastPolledAt: now - 2 * minute, linear: noCycle),
            quietSlack,
        ], items: items))
        model.client.loadDashboardFixture([pageDashboard("p1", tracked: [
            DashboardTrackedSource(source: "linear", label: "Linear", status: .ok, total: 3,
                                   items: [items[2], items[3], items[4]].map(row),
                                   done: DashboardSection(total: 0, items: []), linear: noCycle),
            DashboardTrackedSource(source: "slack", label: "Slack", status: .ok, total: 0),
        ])])
        await render(ProjectPage(projectId: "p1"), size: CGSize(width: 900, height: 820),
                     to: directory.appending(path: "project-tracking-no-cycle.png"))

        // Sign-in required for Linear (cached rows stay), and a project with nothing attached.
        model.client.loadTrackingFixture(TrackingFixture(sources: [
            TrackingSource(id: "p1:linear", projectId: "p1", kind: .linear, label: "Linear", configured: true,
                           status: .signInRequired, error: "Sign in required", signInCommand: "pi mcp login linear",
                           linear: linearSource.linear),
            quietSlack,
        ], items: items))
        let quietProject = ProjectDashboard(
            projectId: "p2", summary: ProjectDashboardSummary(chats: 2),
            recent: DashboardSection(total: 1, items: [
                DashboardRecentItem(sessionId: "d9", title: "Update Ghostty config", outcome: .done,
                                    outcomeAt: now - 26 * 60 * minute),
            ]))
        model.client.loadDashboardFixture([
            pageDashboard("p1", tracked: [
                DashboardTrackedSource(source: "linear", label: "Linear", status: .signInRequired,
                                       error: "Sign in required", total: 7, items: [items[0], items[1], items[2]].map(row),
                                       done: DashboardSection(total: 2, items: doneIssues.map(row)),
                                       linear: linearSource.linear),
                DashboardTrackedSource(source: "slack", label: "Slack", status: .ok, total: 0),
            ]),
            quietProject,
        ])
        await render(ProjectPage(projectId: "p1"), size: CGSize(width: 900, height: 640),
                     to: directory.appending(path: "project-tracking-signin.png"))
        await render(ProjectPage(projectId: "p2"), size: CGSize(width: 900, height: 470),
                     to: directory.appending(path: "project-tracking-none.png"))


        // Start chat and Start mission, prefilled from a ticket.
        let prefill = TrackedItemPrefill(
            itemId: "l418", identifier: "ENG-418", title: "Retry webhook delivery after a 502 from the billing provider",
            url: "https://linear.app/acme/issue/ENG-418",
            description: "Webhooks to the billing provider fail permanently on a single 502. Retry with backoff.",
            gitBranchName: "eng-418-retry-webhook-delivery", prompt: "")
        model.startChat(from: items[1], prefill: prefill)
        await render(TaskComposer(form: model.newSessionForm, client: model.client).padding(24),
                     size: CGSize(width: 700, height: 420), to: directory.appending(path: "tracked-start-chat.png"))
        await render(CreateMissionSheet(projectId: "p1", sourceSessionId: nil,
                                        prefill: TrackedItemText.missionDraft(items[1], prefill: prefill)),
                     size: CGSize(width: 500, height: 640), to: directory.appending(path: "tracked-start-mission.png"))
        print("snapshots written to \(directory.path)")
        exit(0)
    }

    private static func renderProjectPages(model: AppModel, to directory: URL) async {
        let now = Fixtures.now
        let minute = 60_000.0
        let home = Fixtures.home
        let projects = [
            Project(id: "p1", name: "pilot", path: "\(home)/src/github.com/babariviere/pilot",
                    model: "anthropic/claude-opus-5-5", createdAt: now),
            Project(id: "p2", name: "dotfiles", path: "\(home)/src/github.com/babariviere/dotfiles", workspace: "direct",
                    createdAt: now),
            Project(id: "p3", name: "new-service", path: "\(home)/src/github.com/acme/new-service", createdAt: now),
            Project(id: "p4", name: "monorepo-with-a-rather-long-name",
                    path: "\(home)/src/github.com/acme/platform/services/monorepo-with-a-rather-long-name", createdAt: now),
        ]
        func session(_ id: String, _ title: String, state: String = "idle", outcome: SessionOutcome? = nil, ago: Double,
                     mission: String? = nil, branch: String? = nil, project: String = "p1") -> SessionSummary {
            SessionSummary(id: id, title: title, cwd: projects[0].path, projectId: project, branch: branch,
                           createdAt: now - ago, updatedAt: now - ago, state: state, model: "anthropic/claude-opus-5-5",
                           outcome: outcome, outcomeAt: outcome == nil ? nil : now - ago, missionId: mission)
        }
        let sessions = [
            session("w1", "Daemon aggregate endpoint for the project page", state: "working", ago: 14 * minute,
                    mission: "m1", branch: "feat/project-dashboard-api"),
            session("w2", "Wake and online detection", state: "working", ago: 6 * minute, mission: "m1",
                    branch: "feat/wake-detection"),
            session("w3", "Why does the sidebar re-render on every token?", state: "working", ago: minute),
            session("n1", "Fix stale PR badge after force-push", outcome: .done, ago: 12 * minute, branch: "fix/pr-badge"),
            session("n2", "Investigate worker crash on resume", outcome: .failed, ago: 40 * minute),
            session("r1", "Theme tokens for motion", outcome: .done, ago: 120 * minute),
            session("d1", "Update Ghostty config", outcome: .done, ago: 26 * 60 * minute, project: "p2"),
        ]
        model.client.loadFixture(projects: projects, sessions: sessions)
        model.client.loadMissionFixture([])
        func ref(_ number: Int, _ state: PullRequestState = .open) -> DashboardPullRequestRef {
            DashboardPullRequestRef(number: number, url: "https://github.com/babariviere/pilot/pull/\(number)", state: state)
        }
        func pr(_ number: Int, _ title: String, chat: String, state: DashboardPullRequestState = .open,
                readiness: DashboardPullRequestReadiness? = nil) -> DashboardPullRequest {
            DashboardPullRequest(number: number, url: "https://github.com/babariviere/pilot/pull/\(number)", title: title,
                                 state: state, sessionId: "n1", sessionTitle: chat, checkedAt: now, readiness: readiness)
        }
        let populated = ProjectDashboard(
            projectId: "p1",
            summary: ProjectDashboardSummary(chats: 12, working: 3, needsYou: 3, openPullRequests: 4,
                                             readyPullRequests: 1, activeMissions: 2),
            needsYou: DashboardSection(total: 3, items: [
                DashboardNeedsYouItem(kind: .failed, id: "session:n2", title: "Investigate worker crash on resume",
                                      sessionId: "n2", outcome: .failed,
                                      reason: "kernel exited with code 137 while running npm test", at: now - 40 * minute),
                DashboardNeedsYouItem(kind: .question, id: "mission:m1", title: "Project Dashboard and Task Scheduling",
                                      missionId: "m1", count: 1, at: now - 60 * minute),
                DashboardNeedsYouItem(kind: .unread, id: "session:n1", title: "Fix stale PR badge after force-push",
                                      sessionId: "n1", outcome: .done, at: now - 12 * minute),
            ]),
            working: DashboardSection(total: 3, items: [
                DashboardWorkingItem(sessionId: "w3", title: "Why does the sidebar re-render on every token?", mode: .ask,
                                     model: "anthropic/claude-haiku-5", startedAt: now - minute),
                DashboardWorkingItem(sessionId: "w2", title: "Wake and online detection", missionId: "m1",
                                     missionTitle: "Project Dashboard", model: "anthropic/claude-sonnet-5-5",
                                     branch: "feat/wake-detection", pullRequest: ref(421), startedAt: now - 6 * minute),
                DashboardWorkingItem(sessionId: "w1", title: "Daemon aggregate endpoint for the project page",
                                     missionId: "m1", missionTitle: "Project Dashboard", model: "anthropic/claude-opus-5-5",
                                     branch: "feat/project-dashboard-api", startedAt: now - 14 * minute),
            ]),
            pullRequests: DashboardSection(total: 4, items: [
                pr(418, "fix: refresh PR badge after force-push", chat: "Fix stale PR badge after force-push",
                   readiness: .init(state: .ready)),
                pr(421, "feat: detect wake and network return", chat: "Wake and online detection",
                   readiness: .init(state: .pending)),
                pr(415, "feat: tracked items store", chat: "Tracked-items store",
                   readiness: .init(state: .blocked, reasons: ["2 unresolved comments", "failing checks: build"])),
                pr(409, "refactor: split ChatView", chat: "Split ChatView", state: .draft),
            ]),
            missions: DashboardSection(total: 2, items: [
                DashboardMission(id: "m1", title: "Project Dashboard and Task Scheduling", tasksDone: 3,
                                 tasksInReview: 2, tasksInProgress: 3, tasksBlocked: 1, tasksTotal: 13,
                                 working: 2, needsYou: 1),
                DashboardMission(id: "m2", title: "Artifact renderer hardening", tasksDone: 5, tasksInReview: 1,
                                 tasksTotal: 6, working: 0),
            ]),
            recent: DashboardSection(total: 3, items: [
                DashboardRecentItem(sessionId: "r1", title: "Theme tokens for motion", outcome: .done,
                                    outcomeAt: now - 120 * minute, pullRequest: ref(402, .merged)),
                DashboardRecentItem(sessionId: "r2", title: "Explain session feed cache", outcome: .done,
                                    outcomeAt: now - 26 * 60 * minute),
                DashboardRecentItem(sessionId: "r3", title: "Bump pi-durable", outcome: .stopped,
                                    outcomeAt: now - 30 * 60 * minute),
            ])
        )
        // Today's PR data: no readiness until pilotd tracks it, so open PRs read as plain "Open".
        let withoutReadiness = ProjectDashboard(
            projectId: "p1", summary: populated.summary, needsYou: populated.needsYou, working: populated.working,
            pullRequests: DashboardSection(total: 3, items: [
                pr(418, "fix: refresh PR badge after force-push", chat: "Fix stale PR badge after force-push"),
                pr(421, "feat: detect wake and network return", chat: "Wake and online detection"),
                pr(409, "refactor: split ChatView", chat: "Split ChatView", state: .draft),
            ]),
            missions: populated.missions, recent: populated.recent)
        let longTitle = "A deliberately long chat title that keeps going so it has to truncate on a single line"
        let longReason = "Kernel exited with code 137 while running the full npm test suite after the dependency bump; "
            + "the worker was restarted twice and the transcript ends in the middle of a tool call."
        let longNeeds: [DashboardNeedsYouItem] = (1...5).map { index -> DashboardNeedsYouItem in
            let failed = index == 1
            let at: Double = now - Double(index * 17) * minute
            let kind: DashboardNeedsYouKind = failed ? .failed : .unread
            let outcome: SessionOutcome = failed ? .failed : .done
            let reason: String? = failed ? longReason : nil
            return DashboardNeedsYouItem(kind: kind, id: "need-\(index)", title: "\(longTitle) \(index)",
                                         sessionId: "long-\(index)", outcome: outcome, reason: reason, at: at)
        }
        let longWorking: [DashboardWorkingItem] = (1...5).map { index -> DashboardWorkingItem in
            let pullRequest: DashboardPullRequestRef? = index.isMultiple(of: 2) ? ref(1000 + index) : nil
            let startedAt: Double = now - Double(index * 23) * minute
            return DashboardWorkingItem(sessionId: "long-w\(index)", title: "\(longTitle) \(index)", missionId: "lm",
                                        missionTitle: "Migrate every service to the new deployment pipeline",
                                        model: "openai-codex/gpt-6.1-sol",
                                        branch: "feat/a-very-long-branch-name-for-the-deployment-pipeline-\(index)",
                                        pullRequest: pullRequest, startedAt: startedAt)
        }
        let blockers = ["3 unresolved comments", "failing checks: build, lint, e2e", "merge conflicts", "review required"]
        let longPullRequests: [DashboardPullRequest] = (1...5).map { index -> DashboardPullRequest in
            let readiness = index <= 2 ? DashboardPullRequestReadiness(state: .ready)
                : DashboardPullRequestReadiness(state: .blocked, reasons: blockers)
            return pr(2000 + index, "feat: \(longTitle.lowercased()) \(index)", chat: longTitle, readiness: readiness)
        }
        let longMissions: [DashboardMission] = (1...5).map { index -> DashboardMission in
            let needsYou = index == 1 ? 4 : 0
            return DashboardMission(id: "lm\(index)", title: "Migrate every service to the new deployment pipeline \(index)",
                                    tasksDone: index * 2, tasksInReview: 1, tasksInProgress: index % 3,
                                    tasksBlocked: needsYou > 0 ? 1 : 0, tasksTotal: 12, working: index % 3,
                                    needsYou: needsYou)
        }
        let longRecent: [DashboardRecentItem] = (1...5).map { index -> DashboardRecentItem in
            let outcomeAt: Double = now - Double(index) * 3_600_000
            return DashboardRecentItem(sessionId: "long-r\(index)", title: "\(longTitle) \(index)", outcome: .done,
                                       outcomeAt: outcomeAt, pullRequest: ref(3000 + index, .merged))
        }
        let long = ProjectDashboard(
            projectId: "p4",
            summary: ProjectDashboardSummary(chats: 48, working: 9, needsYou: 14, openPullRequests: 11,
                                             readyPullRequests: 3, activeMissions: 7),
            needsYou: DashboardSection(total: 14, items: longNeeds),
            working: DashboardSection(total: 9, items: longWorking),
            pullRequests: DashboardSection(total: 11, items: longPullRequests),
            missions: DashboardSection(total: 7, items: longMissions),
            recent: DashboardSection(total: 30, items: longRecent)
        )
        let quiet = ProjectDashboard(
            projectId: "p2", summary: ProjectDashboardSummary(chats: 2),
            recent: DashboardSection(total: 2, items: [
                DashboardRecentItem(sessionId: "d1", title: "Update Ghostty config", outcome: .done,
                                    outcomeAt: now - 26 * 60 * minute),
                DashboardRecentItem(sessionId: "d2", title: "Why is zsh slow to start?", outcome: .done,
                                    outcomeAt: now - 3 * 24 * 60 * minute),
            ]))
        let fresh = ProjectDashboard(projectId: "p3")
        let pageSize = CGSize(width: 900, height: 900)
        if CommandLine.arguments.contains("--sidebar-scope-only") {
            await renderSidebarScope(model: model, projects: projects, sessions: sessions, dashboard: populated,
                                     to: directory)
            return
        }
        func page(_ id: String, _ name: String, height: CGFloat = 900) async {
            await render(ProjectPage(projectId: id), size: CGSize(width: pageSize.width, height: height),
                         to: directory.appending(path: "project-\(name).png"))
        }
        model.client.loadDashboardFixture([populated, long, quiet, fresh])
        await page("p1", "populated", height: 980)
        await page("p4", "long", height: 1500)
        await page("p2", "quiet", height: 420)
        await page("p3", "new", height: 360)
        model.client.loadDashboardFixture([withoutReadiness])
        await page("p1", "no-readiness", height: 980)
        model.client.loadDashboardFixture([])
        await page("p1", "loading", height: 300)
        model.client.loadDashboardFixture([], errors: ["p1": "HTTP 500"])
        await page("p1", "load-error", height: 360)
        model.client.loadDashboardFixture([populated], receivedAt: Date().addingTimeInterval(-180),
                                          errors: ["p1": "pilotd did not answer"])
        await page("p1", "stale", height: 600)

        // One review sheet with the secondary states side by side.
        let extra = [
            Project(id: "p5", name: "api-gateway", path: "\(home)/src/github.com/acme/api-gateway", createdAt: now),
            Project(id: "p6", name: "billing", path: "\(home)/src/github.com/acme/billing", createdAt: now),
        ]
        model.client.loadFixture(projects: projects + extra, sessions: sessions)
        model.client.loadDashboardFixture([populated, quiet, fresh], receivedAt: Date().addingTimeInterval(-180),
                                          errors: ["p1": "pilotd did not answer", "p6": "HTTP 500"])
        let states: [(title: String, detail: String, id: String, height: CGFloat)] = [
            ("New project", "No chats or missions yet: one empty state with the next steps.", "p3", 230),
            ("Quiet project", "Empty sections hide. Needs you always shows, so nothing waiting is explicit.", "p2", 300),
            ("First load", "A spinner only on first open. Later updates arrive over the WebSocket in place.", "p5", 150),
            ("Load failed", "No data yet and the refresh failed: the error and Retry.", "p6", 220),
            ("Refresh failed", "The last data stays under a muted banner with Retry.", "p1", 330),
        ]
        let sheet = VStack(spacing: 0) {
            ForEach(states, id: \.id) { state in
                VStack(alignment: .leading, spacing: 2) {
                    Text(state.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.foreground)
                    Text(state.detail).font(.pilot(.label)).foregroundStyle(Theme.mutedForeground)
                }
                .padding(.horizontal, 24).padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(hex: 0xEDEDED))
                ProjectPage(projectId: state.id).frame(height: state.height).clipped()
            }
        }
        let sheetHeight = states.reduce(0) { $0 + $1.height + 58 }
        await render(sheet, size: CGSize(width: 900, height: sheetHeight),
                     to: directory.appending(path: "project-states.png"))
        model.client.loadFixture(projects: projects, sessions: sessions)

        // The real window: toolbar title, subtitle, New chat and the actions menu, with the sidebar entry selected.
        model.client.loadDashboardFixture([populated])
        model.openProject("p1")
        for _ in 0..<8 { try? await Task.sleep(for: .milliseconds(100)) }
        guard let window = NSApp.windows.first(where: { $0.toolbar != nil }),
              let frame = window.contentView?.superview else {
            print("No native toolbar window available")
            exit(1)
        }
        window.setFrameOrigin(NSPoint(x: 100, y: 100))
        window.makeKeyAndOrderFront(nil)
        for width in [1360.0, 980.0] {
            window.setContentSize(CGSize(width: width, height: 900))
            for _ in 0..<8 { try? await Task.sleep(for: .milliseconds(100)) }
            snapshot(frame, to: directory.appending(path: "project-window-\(Int(width)).png"))
        }
        print("snapshots written to \(directory.path)")
        exit(0)
    }

    /// The sidebar scope switcher: the real window focused on one project and listing every project,
    /// and the open switcher with counts and shortcuts.
    private static func renderSidebarScope(model: AppModel, projects: [Project], sessions: [SessionSummary],
                                           dashboard: ProjectDashboard, to directory: URL) async {
        let now = Fixtures.now
        let minute = 60_000.0
        let platform = projects[3]
        func other(_ id: String, _ title: String, state: String = "idle", outcome: SessionOutcome? = nil,
                   ago: Double) -> SessionSummary {
            SessionSummary(id: id, title: title, cwd: platform.path, projectId: platform.id, createdAt: now - ago,
                           updatedAt: now - ago, state: state, model: "anthropic/claude-opus-5-5", outcome: outcome,
                           outcomeAt: outcome == nil ? nil : now - ago)
        }
        let all = sessions + [
            other("o1", "Upgrade to Node 24", state: "working", ago: 48 * minute),
            other("o2", "Quote export review", outcome: .done, ago: 60 * minute),
            other("o3", "Explain the quoting pipeline", outcome: .done, ago: 26 * 60 * minute),
        ]
        func mission(_ id: String, _ project: String, _ title: String, needsYou: Int = 0) -> String {
            """
            {"mission":{"id":"\(id)","projectId":"\(project)","title":"\(title)","goal":"","status":"active",
            "needsYouCount":\(needsYou),"briefRevision":1,"createdAt":\(now),"updatedAt":\(now)},"decisions":[],
            "comments":[],"tasks":[],"artifacts":[],"resources":[],"events":[]}
            """
        }
        let json = "[" + [
            mission("m1", "p1", "Project Dashboard and Task Scheduling", needsYou: 1),
            mission("m2", "p1", "Artifact renderer hardening"),
            mission("m3", "p4", "Underwriting migration", needsYou: 1),
        ].joined(separator: ",") + "]"
        guard let missions = try? JSONDecoder().decode([MissionDetail].self, from: Data(json.utf8)) else {
            print("Invalid mission fixture")
            exit(1)
        }
        model.client.loadFixture(projects: projects, sessions: all)
        model.client.loadMissionFixture(missions)
        model.client.loadDashboardFixture([dashboard])
        model.client.loadCountsFixture(ProjectDashboardCounts(projects: [
            "p1": ProjectDashboardCount(working: 3, needsYou: 3),
            "p4": ProjectDashboardCount(working: 1, needsYou: 2),
        ]))
        model.collapsedProjects = ["p2", "p3"]

        let counts = model.client.projectCounts.projects
        await render(SidebarScopeList(projects: model.orderedProjects, scope: nil, counts: counts,
                                      archivedCount: 12, groupsByUrgency: true, choose: { _ in }, showArchive: {},
                                      search: {}, toggleGrouping: {}, addProject: {}, newFolder: {})
                        .background(Theme.background),
                     size: CGSize(width: 300, height: 320), to: directory.appending(path: "scope-switcher.png"))

        model.selectedSessionId = nil
        model.focus(on: "p1")
        for (name, scope) in [("focused", "p1"), ("all", nil)] as [(String, String?)] {
            model.focus(on: scope)
            await render(SessionSidebar(model: model, client: model.client), size: CGSize(width: 280, height: 760),
                         to: directory.appending(path: "scope-sidebar-\(name).png"))
        }
        model.focus(on: "p1")
        for _ in 0..<8 { try? await Task.sleep(for: .milliseconds(100)) }
        guard let window = NSApp.windows.first(where: { $0.toolbar != nil }),
              let frame = window.contentView?.superview else {
            print("No native toolbar window available")
            exit(1)
        }
        window.setFrameOrigin(NSPoint(x: 100, y: 100))
        window.makeKeyAndOrderFront(nil)
        window.setContentSize(CGSize(width: 1360, height: 860))
        for _ in 0..<8 { try? await Task.sleep(for: .milliseconds(100)) }
        snapshot(frame, to: directory.appending(path: "scope-focused-window.png"))

        model.focus(on: nil)
        model.openHome()
        for _ in 0..<8 { try? await Task.sleep(for: .milliseconds(100)) }
        snapshot(frame, to: directory.appending(path: "scope-all-window.png"))

        // Clicking a project name in All projects opens its page without changing scope.
        model.openProject("p1")
        for _ in 0..<8 { try? await Task.sleep(for: .milliseconds(100)) }
        snapshot(frame, to: directory.appending(path: "scope-all-project-window.png"))
        print("snapshots written to \(directory.path)")
        exit(0)
    }

    /// The subagent strip above the composer and the Agents tab: its list and one subagent's detail view.
    private static func renderSubagents(model: AppModel, to directory: URL) async {
        let session = Fixtures.subagentSession
        model.client.loadFixture(projects: Fixtures.projects, sessions: [session] + Fixtures.sessions)
        model.client.fixtureChangeSummaries = [session.id: SessionChangeSummary(
            base: "origin/main", branch: session.branch, fileCount: 3, additions: 48, deletions: 6
        )]
        model.client.fixtureSubagentTranscripts = Fixtures.subagentTranscripts
        let subagents = session.subagents ?? []
        if let read = subagents.first(where: { $0.name == "docs-check" }) { model.markSubagentRead(read, in: session.id) }
        model.selectedSessionId = session.id
        model.selectedSubagents[session.id] = nil
        model.inspectorTab = .agents
        model.inspectorVisible = true
        let feed = SessionFeed(sessionId: session.id, transcript: Fixtures.subagentParentTranscript)
        await render(
            Frame(title: session.title, subtitle: "pilot · \(session.model ?? "")", session: session) {
                HStack(spacing: 0) {
                    ChatView(session: session, feed: feed)
                    Rectangle().fill(Theme.border).frame(width: 1)
                    Inspector(session: session).frame(width: 560)
                }
            },
            size: CGSize(width: 1560, height: 860),
            to: directory.appending(path: "subagents.png")
        )
        model.selectedSubagents[session.id] = "protocol-audit"
        await render(
            Frame(title: session.title, subtitle: "pilot · \(session.model ?? "")", session: session) {
                HStack(spacing: 0) {
                    ChatView(session: session, feed: feed)
                    Rectangle().fill(Theme.border).frame(width: 1)
                    Inspector(session: session).frame(width: 560)
                }
            },
            size: CGSize(width: 1560, height: 860),
            to: directory.appending(path: "subagent-detail.png")
        )
        model.selectedSubagents[session.id] = nil
        await render(
            Frame(title: session.title, subtitle: "pilot · \(session.model ?? "")", session: session) {
                ChatView(session: session, feed: SessionFeed(sessionId: session.id, transcript: Fixtures.subagentParentTranscript))
            },
            size: CGSize(width: 1100, height: 760),
            to: directory.appending(path: "subagents-strip.png")
        )
        // Leave transcript content under the fixed footer to catch transparent inset regressions.
        await render(
            ChatView(session: session, feed: SessionFeed(sessionId: session.id, transcript: Fixtures.subagentParentTranscript))
                .background(Theme.background),
            size: CGSize(width: 1100, height: 420),
            to: directory.appending(path: "subagents-scrolled.png"),
            scrollTranscriptUp: true
        )
    }

    /// Against a running pilotd (PILOT_PORT) and an existing session (PILOT_TEST_SESSION): opens a real window
    /// with the session's terminal, types into the daemon-owned shell, reattaches (as after an app restart) and
    /// checks the scrollback replay, then exits the shell and restarts it.
    private static func terminalExitTest(directory: URL) async {
        NSApp.appearance = NSAppearance(named: .aqua)
        for window in NSApp.windows { window.orderOut(nil) }
        let model = AppModel.shared
        let sessionId = ProcessInfo.processInfo.environment["PILOT_TEST_SESSION"] ?? ""
        model.client.connect(to: model.daemon.baseURL)
        model.daemon.markRunningForSnapshot()
        model.terminals.bind(to: model.settings)

        func wait(_ seconds: Double, until done: () -> Bool) async -> Bool {
            let deadline = Date().addingTimeInterval(seconds)
            while Date() < deadline {
                if done() { return true }
                try? await Task.sleep(for: .milliseconds(100))
            }
            return done()
        }
        func fail(_ step: String) -> Never {
            print("terminal-test failed at \(step)")
            exit(1)
        }
        guard await wait(5, until: { model.client.connected && model.client.session(sessionId) != nil }),
              let session = model.client.session(sessionId)
        else { fail("connect") }

        model.selectedSessionId = session.id
        model.inspectorVisible = true
        model.inspectorTab = .terminal
        let size = CGSize(width: 1200, height: 700)
        let root = SessionDetail(session: session, feed: SessionFeed(sessionId: session.id, transcript: Transcript()))
            .environmentObject(model)
            .environment(\.pilotFonts, model.settings.fonts)
            .frame(width: size.width, height: size.height)
        let hosting = NSHostingView(rootView: root)
        let window = NSWindow(contentRect: CGRect(origin: .zero, size: size), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = hosting
        window.setFrameOrigin(NSPoint(x: 40, y: 40))
        window.orderFrontRegardless()

        let store = model.terminals
        func screen() -> String { store.memories[session.id]?.readViewportText() ?? "" }
        func type(_ text: String) {
            guard let state = store.states[session.id] else { return }
            for character in text {
                if let press = TerminalKeyPress(typing: character) { state.sendKey(press) }
            }
            state.sendKey(.enter)
        }

        guard await wait(5, until: { store.states[session.id] != nil }) else { fail("attach") }
        guard await wait(10, until: { !screen().trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else { fail("prompt") }
        type("echo pilot-roundtrip")
        // The command's own output line, not just the echoed input.
        func printed() -> Bool { screen().split(separator: "\n").contains { $0.trimmingCharacters(in: .whitespaces) == "pilot-roundtrip" } }
        guard await wait(10, until: printed) else { fail("roundtrip") }

        // Drop the surface and attach again, as a relaunched app would: the daemon replays scrollback.
        store.remove(session.id)
        store.ensure(session)
        guard await wait(10, until: printed) else { fail("replay") }
        try? await Task.sleep(for: .seconds(1))

        type("exit")
        if !(await wait(4, until: { store.exited.contains(session.id) })) { type("exit") }
        guard await wait(5, until: { store.exited.contains(session.id) && store.states[session.id] == nil }) else {
            print("screen: \(screen().split(separator: "\n").filter { !$0.isEmpty }.suffix(4))")
            fail("exit")
        }
        try? await Task.sleep(for: .milliseconds(400))
        snapshot(hosting, to: directory.appending(path: "terminal-exited.png"))

        store.restart(session)
        guard await wait(10, until: { !screen().trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else { fail("restart") }
        guard !printed() else { fail("restart-fresh") }
        print("terminal-test passed: roundtrip, replay, exit, restart")
        exit(0)
    }

    private static func snapshot(_ view: NSView, to url: URL) {
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
    }

    /// These message fixtures are pure SwiftUI. ImageRenderer avoids macOS compositing
    /// omitting offscreen NSHostingView content from cacheDisplay screenshots.
    private static func renderMessageFixture<V: View>(_ view: V, size: CGSize, to url: URL) {
        let renderer = ImageRenderer(content: view
            .environment(\.pilotFonts, AppSettings.shared.fonts)
            .frame(width: size.width, height: size.height)
            .background(Theme.background))
        renderer.scale = 1
        guard let image = renderer.cgImage else { return }
        let rep = NSBitmapImageRep(cgImage: image)
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
    }

    static func render<V: View>(_ view: V, size: CGSize, to url: URL, completionPreview: Bool = false,
                                       completionText: String? = nil,
                                       scrollEditorToEnd: Bool = false, scrollTranscriptUp: Bool = false,
                                       appearance: NSAppearance.Name = .aqua) async {
        let root = view
            .environmentObject(AppModel.shared)
            .environment(\.pilotFonts, AppSettings.shared.fonts)
            .frame(width: size.width, height: size.height)
        let hosting = NSHostingView(rootView: root)
        hosting.frame = CGRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: hosting.frame, styleMask: completionPreview ? [.titled] : [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: appearance)
        window.contentView = hosting
        window.setFrameOrigin(completionPreview ? NSPoint(x: 100, y: 100) : NSPoint(x: -10000, y: -10000))
        window.orderFrontRegardless()
        // Let lists, lazy stacks, images and async loads settle. Sleeping (not spinning the run loop)
        // lets other main-actor work, such as a pane's load, run meanwhile.
        for _ in 0 ..< 8 {
            hosting.layoutSubtreeIfNeeded()
            try? await Task.sleep(for: .milliseconds(100))
        }
        if scrollTranscriptUp {
            func findTranscript(_ view: NSView) -> NSScrollView? {
                if let observer = view as? ScrollObserverView { return observer.enclosingScrollView }
                return view.subviews.lazy.compactMap { findTranscript($0) }.first
            }
            guard let scroll = findTranscript(hosting), let document = scroll.documentView else {
                fatalError("Scrollable transcript missing from footer regression snapshot")
            }
            let bottom = max(0, document.bounds.height - scroll.contentView.bounds.height + scroll.contentInsets.bottom)
            precondition(bottom > 0, "Footer regression snapshot needs an overflowing transcript")
            let offset = min(120, bottom)
            scroll.contentView.scroll(to: NSPoint(x: 0, y: document.isFlipped ? bottom - offset : offset))
            scroll.reflectScrolledClipView(scroll.contentView)
            try? await Task.sleep(for: .milliseconds(300))
        }
        var previewEditor: SubmitTextView?
        if completionPreview || scrollEditorToEnd {
            func findEditor(_ view: NSView) -> SubmitTextView? {
                if let editor = view as? SubmitTextView { return editor }
                return view.subviews.lazy.compactMap { findEditor($0) }.first
            }
            guard let editor = findEditor(hosting) else { return }
            if completionPreview {
                previewEditor = editor
                window.makeKeyAndOrderFront(nil)
                window.makeFirstResponder(editor)
                if let completionText {
                    editor.insertText(completionText, replacementRange: NSRange(location: 0, length: 0))
                } else {
                    editor.insertText("Please review apps/macos/Sources/Pilot/Cha", replacementRange: NSRange(location: 0, length: 0))
                    try? await Task.sleep(for: .milliseconds(300))
                    editor.completionDirectory = AppModel.shared.daemon.repoURL.path
                    editor.insertTab(nil)
                }
            } else {
                let end = NSRange(location: editor.string.utf16.count, length: 0)
                editor.setSelectedRange(end)
                editor.scrollRangeToVisible(end)
                if let scroll = editor.enclosingScrollView {
                    scroll.contentView.scroll(to: NSPoint(x: 0, y: scroll.contentView.bounds.minY))
                    scroll.reflectScrolledClipView(scroll.contentView)
                }
            }
            try? await Task.sleep(for: .milliseconds(300))
        }
        // 1x output keeps review images small.
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: Int(size.width), pixelsHigh: Int(size.height), bitsPerSample: 8,
            samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ) else { return }
        rep.size = size
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        if completionPreview {
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
            for panel in window.childWindows ?? [] {
                guard panel.isVisible, let content = panel.contentView,
                      let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) else { continue }
                content.cacheDisplay(in: content.bounds, to: bitmap)
                let image = NSImage(size: content.bounds.size)
                image.addRepresentation(bitmap)
                let frame = panel.convertToScreen(content.frame)
                image.draw(in: CGRect(x: frame.minX - window.frame.minX, y: frame.minY - window.frame.minY,
                                      width: frame.width, height: frame.height),
                           from: .zero, operation: .sourceOver, fraction: 1)
            }
            NSGraphicsContext.restoreGraphicsState()
        }
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
        previewEditor?.dismissCompletionPicker()
        window.orderOut(nil)
    }

    /// Sidebar plus a stand-in for the window toolbar.
    private struct Frame<Content: View>: View {
        let title: String
        let subtitle: String?
        var status: SessionStatus = .working
        var session: SessionSummary? = nil
        @ViewBuilder let content: Content

        var body: some View {
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    HStack(spacing: 7) {
                        ForEach([Color(hex: 0xFF5F57), Color(hex: 0xFEBC2E), Color(hex: 0x28C840)], id: \.self) {
                            Circle().fill($0).frame(width: 12, height: 12)
                        }
                        Spacer()
                    }
                    .padding(.horizontal, 14)
                    .frame(height: 44)
                    SessionSidebar(model: AppModel.shared, client: AppModel.shared.client)
                }
                .frame(width: 280)
                .background(Theme.sidebar)
                Rectangle().fill(Theme.border).frame(width: 1)
                VStack(spacing: 0) {
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(title).font(.system(size: 13, weight: .semibold))
                            if let subtitle {
                                Text(session.map { SessionHeaderContext.subtitle(for: $0, place: "pilot") } ?? subtitle)
                                    .font(.system(size: 11)).foregroundStyle(Theme.mutedForeground)
                                    .lineLimit(1).truncationMode(.middle)
                            }
                        }
                        Spacer()
                        if subtitle != nil {
                            if let session {
                                if AppModel.shared.isUnread(session) { UnreadBadge() }
                                if session.isAsk { SessionContextBadge(session: session) }
                                SessionInspectorControls(session: session)
                                // Outside a real toolbar, a menu takes all offered width.
                                SessionMoreActions(session: session).fixedSize()
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .frame(height: 44)
                    .background(Theme.background)
                    Rectangle().fill(Theme.border).frame(height: 1)
                    content
                }
                .background(Theme.background)
            }
        }
    }
}

enum Fixtures {
    static let now = Date().timeIntervalSince1970 * 1000
    static let home = FileManager.default.homeDirectoryForCurrentUser.path

    static let codexUsage = SessionUsage(
        context: ContextUsage(tokens: 42_600, contextWindow: 200_000, percent: 21.3),
        subscription: SubscriptionUsage(fetchedAt: now - 120_000, provider: .openai, windows: [
            SubscriptionWindow(label: "5h", usedPercent: 34, resetsAt: "2026-06-15T18:00:00Z"),
            SubscriptionWindow(label: "Week", usedPercent: 68, resetsAt: "2026-06-22T12:00:00Z"),
        ])
    )
    static let claudeUsage = SessionUsage(
        context: ContextUsage(tokens: 182_000, contextWindow: 200_000),
        subscription: SubscriptionUsage(fetchedAt: now - 600_000, provider: .anthropic, windows: [
            SubscriptionWindow(label: "5h", usedPercent: 92, resetsAt: "2026-06-15T19:30:00.000Z"),
            SubscriptionWindow(label: "Week", usedPercent: 45),
        ])
    )

    static let projects = [
        Project(id: "p1", name: "pilot", path: "\(home)/src/github.com/babariviere/pilot", model: "openai-codex/gpt-6.1-sol", createdAt: now),
        Project(id: "p2", name: "pi-extensions", path: "\(home)/src/github.com/babariviere/pi-extensions", createdAt: now),
    ]

    static let sidebarLayoutSessions = [
        SessionSummary(id: "layout-working", title: "Add Remote Branch Support", cwd: projects[0].path, projectId: "p1",
                       createdAt: now, updatedAt: now, state: "starting"),
        SessionSummary(id: "layout-done", title: "Improve Thread Rendering and Alignment", cwd: projects[0].path, projectId: "p1",
                       branch: "fix/improve-thread-rendering-and-alignment", createdAt: now, updatedAt: now - 14 * 3_600_000,
                       state: "idle", outcome: .done,
                       pullRequest: SessionPullRequest(number: 48, url: "https://github.com/babariviere/pilot/pull/48",
                                                      title: "Improve thread rendering", state: .merged, checkedAt: now)),
        SessionSummary(id: "layout-large", title: "Large change counts still fit", cwd: projects[0].path, projectId: "p1",
                       branch: "fix/large-repository-change-counts", createdAt: now, updatedAt: now - 15 * 3_600_000,
                       state: "idle", outcome: .done,
                       pullRequest: SessionPullRequest(number: 12345, url: "https://github.com/babariviere/pilot/pull/12345",
                                                      title: "Large change", state: .open, checkedAt: now)),
        SessionSummary(id: "layout-branch", title: "Branch without repository summary", cwd: projects[0].path, projectId: "p1",
                       branch: "fix/a-very-long-branch-name-without-pull-request-metadata", createdAt: now,
                       updatedAt: now - 16 * 3_600_000, state: "starting"),
        // Second-line layout: several PRs and a long mission fade before the corner, Ask reads "Ask · source" and a
        // coordinator stays distinct.
        SessionSummary(id: "layout-prs", title: "Designing the /v2/scenario API rollout", cwd: projects[0].path,
                       projectId: "p1", branch: "feat/scenario-v2-rollout", createdAt: now, updatedAt: now - 17 * 3_600_000,
                       state: "idle", outcome: .done, outcomeAt: now - 17 * 3_600_000,
                       pullRequests: [6555, 6554, 6553].map {
                           SessionPullRequest(number: $0, url: "https://github.com/babariviere/pilot/pull/\($0)",
                                              title: "Scenario part", state: .open, checkedAt: now)
                       }, missionId: "layout-mission"),
        SessionSummary(id: "layout-ask", title: "Where does the scheduler wake agents?", cwd: projects[0].path,
                       projectId: "p1", createdAt: now, updatedAt: now - 18 * 3_600_000, state: "idle",
                       outcome: .question, outcomeAt: now - 18 * 3_600_000,
                       outcomeReason: "Should I include the power-pause path too?", mode: .ask, sourceBranch: "main"),
        SessionSummary(id: "layout-coordinator", title: "Coordinate the scenario rollout", cwd: projects[0].path,
                       projectId: "p1", createdAt: now, updatedAt: now, state: "working", missionId: "layout-mission",
                       activeMissionCoordinator: true),
    ]

    static let sidebarLayoutMission = Mission(id: "layout-mission", projectId: "p1", title: "New /v2/scenario rollout",
                                              goal: "", coordinatorSessionId: "layout-coordinator", createdAt: now,
                                              updatedAt: now)

    static let sessions = [
        SessionSummary(id: "s1", title: "Fix flaky reopen test in kernel session", cwd: projects[0].path, projectId: "p1",
                       branch: "pilot/fix-flaky-reopen-test-55cb84",
                       createdAt: now - 3_600_000, updatedAt: now - 133_000, state: "working", model: "openai-codex/gpt-6.1-sol",
                       usage: codexUsage, sessionPath: "\(home)/.local/share/pilot/sessions/s1"),
        SessionSummary(id: "s2", title: "Add projects API to pilotd", cwd: projects[0].path, projectId: "p1",
                       createdAt: now - 86_400_000, updatedAt: now - 3_000_000, state: "idle", model: "openai-codex/gpt-6.1-sol",
                       outcome: .done, outcomeAt: now - 3_000_000, outcomeReason: "Projects API implemented and tests passed."),
        SessionSummary(id: "s3", title: "Review subagents durable storage", cwd: projects[1].path, projectId: "p2",
                       createdAt: now - 2 * 86_400_000, updatedAt: now - 600_000, state: "working", model: "anthropic/claude-opus-5-5",
                       usage: claudeUsage),
        SessionSummary(id: "s4", title: "Sandbox floor for night runs", cwd: projects[1].path, projectId: "p2",
                       createdAt: now - 4 * 86_400_000, updatedAt: now - 90_000_000, state: "failed", model: "anthropic/claude-sonnet-5",
                       error: "Kernel exited with code 1"),
        SessionSummary(id: "s5", title: "Explain the Harness task graph", cwd: "\(home)/scratch",
                       createdAt: now - 6 * 86_400_000, updatedAt: now - 400_000_000, state: "parked",
                       outcome: .done, outcomeAt: now - 400_000_000, outcomeReason: "Which part of the task graph should I document first?"),
    ]

    static let orderingSessions: [SessionSummary] = {
        func session(_ id: String, _ title: String, activity: Double, finish: Double?,
                     state: String = "idle", pr: PullRequestState? = nil, pinned: Bool? = nil) -> SessionSummary {
            SessionSummary(id: id, title: title, cwd: projects[0].path, projectId: "p1",
                           createdAt: now - 86_400_000, updatedAt: activity, state: state,
                           outcome: finish == nil ? nil : .done, outcomeAt: finish,
                           pullRequest: pr.map { SessionPullRequest(number: id == "order-merged" ? 12 : 11,
                               url: "https://github.com/babariviere/pilot/pull/11", title: title,
                               state: $0, checkedAt: now) },
                           lastUserMessageAt: now - 7_200_000, pinned: pinned)
        }
        return [
            session("order-pinned-merged", "Pinned merged PR", activity: now, finish: now - 3_600_000,
                    pr: .merged, pinned: true),
            session("order-pinned-working", "Pinned working chat", activity: now - 60_000, finish: nil,
                    state: "working", pinned: true),
            session("order-merged", "Merged PR, no attention", activity: now, finish: now, pr: .merged),
            session("order-closed", "Closed PR, no attention", activity: now, finish: now, pr: .closed),
            session("order-polled", "Old completion, just polled", activity: now, finish: now - 3_600_000),
            session("order-working", "Agent still working", activity: now - 60_000, finish: nil, state: "working", pr: .open),
            session("order-finished", "Agent just finished", activity: now, finish: now),
            session("order-draft", "Draft PR, completed earlier", activity: now, finish: now - 600_000, pr: .draft),
        ]
    }()

    static let subagentSession = SessionSummary(
        id: "subagents", title: "Audit protocol sync between daemon and app", cwd: projects[0].path, projectId: "p1",
        branch: "feat/protocol-audit", createdAt: now - 1_800_000, updatedAt: now - 20_000, state: "working",
        model: "anthropic/claude-opus-5-5", usage: claudeUsage,
        subagents: [
            SessionSubagent(name: "protocol-audit", state: .working,
                            task: "Map every SessionEvent the daemon emits and list the ones the Swift client ignores. Do not edit files.",
                            createdAt: now - 72_000, cwd: projects[0].path, model: "anthropic/claude-sonnet-5-5"),
            SessionSubagent(name: "swift-mirror", state: .idle,
                            task: "Check that PilotCore mirrors packages/protocol. Report missing or extra fields.",
                            createdAt: now - 400_000, cwd: projects[0].path, model: "anthropic/claude-sonnet-5-5", lastAnswerId: "41"),
            SessionSubagent(name: "test-runner", state: .idle, task: "Run the kernel tests and summarize failures.",
                            createdAt: now - 300_000, cwd: projects[0].path, model: "anthropic/claude-sonnet-5-5",
                            error: "model_error: overloaded"),
            SessionSubagent(name: "docs-check", state: .idle, task: "Check README.md against the current implementation.",
                            createdAt: now - 500_000, cwd: projects[0].path, model: "anthropic/claude-sonnet-5-5", lastAnswerId: "12"),
        ]
    )

    static var subagentParentTranscript: Transcript {
        var transcript = Transcript()
        let events = #"""
        [{"type":"snapshot","entries":[
          {"id":1,"kind":"pi.user","model":[{"role":"user","content":"Audit the protocol and make sure the Swift side is in sync."}]},
          {"id":2,"kind":"pi.assistant","model":[{"role":"assistant","stopReason":"toolUse","content":[{"type":"text","text":"I'll split this across four subagents and merge their findings."},{"type":"toolCall","id":"s1","name":"subagent","arguments":{"action":"spawn","name":"protocol-audit","message":"Map every SessionEvent the daemon emits."}},{"type":"toolCall","id":"s2","name":"subagent","arguments":{"action":"spawn","name":"swift-mirror","message":"Check that PilotCore mirrors packages/protocol."}}]}]},
          {"id":3,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":"s1","toolName":"subagent","isError":false,"content":[{"type":"text","text":"Started protocol-audit."}]}]},
          {"id":4,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":"s2","toolName":"subagent","isError":false,"content":[{"type":"text","text":"Started swift-mirror."}]}]},
          {"id":5,"kind":"pi.user","model":[{"role":"user","content":"[subagent \"docs-check\" answered, no reply needed] README.md matches the current implementation. The development section lists the supported checks."}]},
          {"id":6,"kind":"pi.assistant","model":[{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"docs-check found nothing stale. Waiting on protocol-audit before editing Protocol.swift."}]}]},
          {"id":7,"kind":"pi.user","model":[{"role":"user","content":"[subagent \"swift-mirror\" answered, no reply needed] SessionSummary is missing three fields on the Swift side: sourceCommit, outcomeReason and pullRequestError."}]}
        ],"tools":[],"compactions":[],"inbox":[],"agent":{},"usage":{},"run":{"inputs":[7]}}]
        """#
        if let parsed = try? JSONValue.decode(Data(events.utf8)), let list = parsed.array { transcript.apply(list) }
        return transcript
    }

    static var subagentTranscripts: [String: [JSONValue]] {
        let audit = #"""
        [{"type":"snapshot","entries":[
          {"id":1,"kind":"pi.user","model":[{"role":"user","content":"Map every SessionEvent the daemon emits and list the ones the Swift client ignores. Do not edit files."}]},
          {"id":2,"kind":"pi.assistant","model":[{"role":"assistant","stopReason":"toolUse","content":[{"type":"text","text":"I'll start from the protocol types, then check the Swift decoder."},{"type":"toolCall","id":"a1","name":"read","arguments":{"path":"packages/protocol/src/index.ts"}},{"type":"toolCall","id":"a2","name":"bash","arguments":{"command":"rg -n 'type:' packages/daemon/src"}}]}]},
          {"id":3,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":"a1","toolName":"read","isError":false,"content":[{"type":"text","text":"export type AgentEvent = ..."}]}]},
          {"id":4,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":"a2","toolName":"bash","isError":false,"content":[{"type":"text","text":"11 matches"}]}]},
          {"id":5,"kind":"pi.assistant","model":[{"role":"assistant","stopReason":"toolUse","content":[{"type":"text","text":"The daemon emits **11** event kinds. PilotCore decodes 9; compaction events fall through to the unknown case."},{"type":"toolCall","id":"a3","name":"read","arguments":{"path":"apps/macos/Sources/PilotCore/Transcript.swift"}}]}]}
        ],"tools":[],"compactions":[],"inbox":[],"agent":{},"usage":{}}]
        """#
        let mirror = #"""
        [{"type":"snapshot","entries":[
          {"id":1,"kind":"pi.user","model":[{"role":"user","content":"Check that PilotCore mirrors packages/protocol. Report missing or extra fields."}]},
          {"id":2,"kind":"pi.assistant","model":[{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"SessionSummary is missing three fields on the Swift side: sourceCommit, outcomeReason and pullRequestError."}]}]}
        ],"tools":[],"compactions":[],"inbox":[],"agent":{},"usage":{}}]
        """#
        let tests = #"""
        [{"type":"snapshot","entries":[
          {"id":1,"kind":"pi.user","model":[{"role":"user","content":"Run the kernel tests and summarize failures."}]},
          {"id":2,"kind":"pi.assistant","model":[{"role":"assistant","stopReason":"error","errorMessage":"model_error: overloaded","content":[]}]}
        ],"tools":[],"compactions":[],"inbox":[],"agent":{},"usage":{}}]
        """#
        func parse(_ text: String) -> [JSONValue] { (try? JSONValue.decode(Data(text.utf8)))?.array ?? [] }
        return ["protocol-audit": parse(audit), "swift-mirror": parse(mirror), "test-runner": parse(tests)]
    }

    static let pullRequestSessions: [SessionSummary] = [
        SessionSummary(id: "pr-open", title: "Fix flaky reopen test in kernel session", cwd: projects[0].path, projectId: "p1",
                       branch: "pilot/fix-flaky-reopen-test-55cb84", createdAt: now - 3_600_000, updatedAt: now - 133_000,
                       state: "working", model: "openai-codex/gpt-6.1-sol", usage: codexUsage,
                       pullRequest: SessionPullRequest(number: 7, url: "https://github.com/babariviere/pilot/pull/7",
                                                      title: "Fix flaky reopen test", state: .open, checkedAt: 1_781_524_800_000)),
        SessionSummary(id: "pr-merged", title: "Add projects API to pilotd", cwd: projects[0].path, projectId: "p1",
                       createdAt: now - 86_400_000, updatedAt: now - 3_000_000, state: "idle", model: "openai-codex/gpt-6.1-sol",
                       outcome: .done, outcomeAt: 1_781_524_800_000, outcomeReason: "Projects API implemented and tests passed.",
                       pullRequest: SessionPullRequest(number: 4, url: "https://github.com/babariviere/pilot/pull/4",
                                                      title: "Add projects API", state: .merged, checkedAt: 1_781_524_800_000)),
        SessionSummary(id: "pr-draft", title: "Document durable storage", cwd: projects[0].path, projectId: "p1",
                       createdAt: now - 2 * 86_400_000, updatedAt: now - 600_000, state: "idle",
                       outcome: .done, outcomeAt: 1_781_524_800_001, outcomeReason: "Which storage flow should I document first?",
                       pullRequest: SessionPullRequest(number: 8, url: "https://github.com/babariviere/pilot/pull/8",
                                                      title: "Document durable storage", state: .draft, checkedAt: 1_781_524_800_000)),
        SessionSummary(id: "pr-closed", title: "Explore alternate scheduler", cwd: projects[0].path, projectId: "p1",
                       createdAt: now - 4 * 86_400_000, updatedAt: now - 90_000_000, state: "parked",
                       outcome: .stopped, outcomeAt: 1_781_524_800_002,
                       pullRequest: SessionPullRequest(number: 5, url: "https://github.com/babariviere/pilot/pull/5",
                                                      title: "Explore alternate scheduler", state: .closed, checkedAt: 1_781_524_800_000)),
        SessionSummary(id: "pr-stale", title: "Add projects API, offline lookup", cwd: projects[0].path, projectId: "p1",
                       createdAt: now - 5 * 86_400_000, updatedAt: now - 120_000, state: "idle", model: "openai-codex/gpt-6.1-sol",
                       outcome: .done, outcomeAt: 1_781_524_800_003, outcomeReason: "Projects API implemented and tests passed.",
                       pullRequest: SessionPullRequest(number: 9, url: "https://github.com/babariviere/pilot/pull/9",
                                                      title: "Add projects API", state: .open, checkedAt: 1_781_521_200_000),
                       pullRequestError: "GitHub lookup failed: network offline"),
    ]

    static let questionText = "I can document either the task scheduling flow or the durable storage flow. **Which should I cover first?**"
    static let completionText = "Implemented the projects API, including create, update, list and delete. All tests passed."

    static func settledTranscript(text: String = completionText) -> Transcript {
        var transcript = Transcript()
        transcript.apply(.object([
            "type": .string("snapshot"),
            "entries": .array([.object([
                "id": .number(1), "kind": .string("pi.assistant"),
                "model": .array([.object(["role": .string("assistant"), "content": .string(text)])]),
            ])]),
            "tools": .array([]), "inbox": .array([]), "run": .null,
        ]))
        return transcript
    }

    static func questionTranscript(multiSelect: Bool, answered: Bool) -> Transcript {
        let question: JSONValue = multiSelect
            ? .object([
                "question": .string("Which checks should run before I open the PR?"),
                "context": .string("The full suite takes about six minutes."),
                "multiSelect": .bool(true),
                "options": .array([
                    .object(["label": .string("Typecheck"), "detail": .string("pnpm typecheck"), "suggested": .bool(true)]),
                    .object(["label": .string("Fast tests"), "detail": .string("pnpm test:fast")]),
                    .object(["label": .string("Full tests"), "detail": .string("pnpm test, including stress groups")]),
                    .object(["label": .string("Swift build"), "detail": .string("apps/macos/scripts/build.sh")]),
                ]),
            ])
            : .object([
                "question": .string("Where should the retry logic live?"),
                "context": .string("Both callers share the HTTP client, but only the sync worker needs backoff today."),
                "options": .array([
                    .object(["label": .string("In the shared HTTP client"),
                             "detail": .string("Every caller gets retries. Touches four files."), "suggested": .bool(true)]),
                    .object(["label": .string("Only in the sync worker"),
                             "detail": .string("Smallest change. The client stays unchanged.")]),
                    .object(["label": .string("Behind a retry policy option"),
                             "detail": .string("Callers opt in. Adds a config field.")]),
                ]),
            ])
        func message(_ id: Int, _ kind: String, _ role: String, _ content: JSONValue) -> JSONValue {
            .object(["id": .number(Double(id)), "kind": .string(kind),
                     "model": .array([.object(["role": .string(role), "content": content])])])
        }
        var entries: [JSONValue] = [
            message(1, "pi.user", "user", .string("Add retries to the sync worker's uploads.")),
            message(2, "pi.assistant", "assistant", .string("The upload path goes through the shared HTTP client, so there are two reasonable places for retries.")),
            .object(["id": .number(3), "kind": .string(AgentQuestion.entryKind), "data": question, "model": .array([])]),
        ]
        if answered {
            entries.append(message(4, "pi.user", "user", .string("Only in the sync worker")))
            entries.append(message(5, "pi.assistant", "assistant", .string("Retries now live in the sync worker, with jittered backoff.")))
        }
        var transcript = Transcript()
        transcript.apply(.object([
            "type": .string("snapshot"), "entries": .array(entries),
            "tools": .array([]), "inbox": .array([]), "run": .null,
        ]))
        return transcript
    }

    static let changes = SessionChanges(
        base: "origin/main",
        branch: "pilot/fix-flaky-reopen-test-55cb84",
        files: [
            ChangedFile(path: "packages/kernel/src/session.ts", status: "modified", additions: 9, deletions: 1),
            ChangedFile(path: "packages/kernel/src/session.test.ts", status: "added", additions: 4, deletions: 0),
        ],
        diff: [
            "diff --git a/packages/kernel/src/session.ts b/packages/kernel/src/session.ts",
            "--- a/packages/kernel/src/session.ts",
            "+++ b/packages/kernel/src/session.ts",
            "@@ -61,7 +61,15 @@ export class KernelSession {",
            "   static async open(spec: KernelSpec, hooks: KernelSessionHooks): Promise<KernelSession> {",
            "-    const owned = await openSessionStorage(spec.storageDir);",
            "+    const deadline = Date.now() + 2_000;",
            "+    let owned: OwnedStorage | undefined;",
            "+    while (!owned) {",
            "+      try {",
            "+        owned = await openSessionStorage(spec.storageDir);",
            "+      } catch (error) {",
            "+        if (!(error instanceof StorageBusy) || Date.now() > deadline) throw error;",
            "+        await sleep(25);",
            "+      }",
            "     let adapter: NativeAdapter | undefined;",
            "diff --git a/packages/kernel/src/session.test.ts b/packages/kernel/src/session.test.ts",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/packages/kernel/src/session.test.ts",
            "@@ -0,0 +1,4 @@",
            "+test(\"reopens while the previous owner closes\", async () => {",
            "+  const first = await KernelSession.open(spec, hooks);",
            "+  await Promise.all([first.close(), KernelSession.open(spec, hooks)]);",
            "+});",
        ].joined(separator: "\n")
    )

    static var queuedTranscript: Transcript {
        var transcript = transcript
        let event = #"{"type":"queue_update","items":[{"id":20,"mode":"followUp","content":"Also check that queued messages reappear after reconnecting.\nInclude the results in your summary."},{"id":21,"mode":"steer","content":"Keep the change focused on the queue UI."}]}"#
        transcript.apply(try! JSONValue.decode(Data(event.utf8)))
        return transcript
    }

    static var systemMessagesTranscript: Transcript {
        var transcript = queuedTranscript
        transcript.working = true
        let now = Date().timeIntervalSince1970 * 1_000
        transcript.apply(.object([
            "type": .string("queue_update"),
            "items": .array([.object([
                "id": .number(20), "mode": .string("followUp"),
                "content": .string("Also check the narrow window layout when you are done."),
            ])]),
            "automatic": .array([
                ("coordinator", "steer", "Use the hairline divider from PageComponents instead of adding a new one.", 0.0),
                ("job", "followUp", "pnpm test finished: 412 passed, 0 failed (3m 12s).", 60_000),
                ("pullRequest", "followUp", "CI failed on #318: swift-test (QueueEditingTest.testRemoval).", 240_000),
            ].enumerated().map { index, item in
                .object([
                    "id": .number(Double(30 + index)), "origin": .string(item.0), "mode": .string(item.1),
                    "preview": .string(item.2), "queuedAt": .number(now - item.3),
                ])
            }),
        ]))
        return transcript
    }

    static var longQueuedTranscript: Transcript {
        var transcript = queuedTranscript
        transcript.apply(.object([
            "type": .string("queue_update"),
            "items": .array((1 ... 8).map { index in
                .object([
                    "id": .number(Double(index + 20)),
                    "mode": .string("followUp"),
                    "content": .string("Queued follow-up \(index)\nRun the tests and report any failures. Keep all pending messages accessible without hiding the chatbox."),
                ])
            }),
        ]))
        return transcript
    }

    static var transcript: Transcript {
        var transcript = Transcript()
        let events = #"""
        [
        {"type":"snapshot","entries":[{"id":1,"kind":"pi.user","model":[{"role":"user","content":"The reopen test in packages/kernel is flaky on CI. Find the race and fix it."}]},{"id":3,"kind":"pi.assistant","model":[{"role":"assistant","stopReason":"toolUse","content":[{"type":"thinking","thinking":"I should look at how the storage lease is released when the harness closes, and whether the test reopens before release."},{"type":"text","text":"I'll start by reading the session close path and the test."},{"type":"toolCall","id":"c1","name":"codemode","arguments":{"code":"text(await tools.bash({command:\"rg -n 'release|close' packages/kernel/src/session.ts\"}));"}},{"type":"toolCall","id":"c2","name":"read","arguments":{"path":"packages/kernel/src/storage.ts"}}]}]},{"id":4,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":"c1","toolName":"codemode","isError":false,"content":[{"type":"text","text":"142: await this.harness.close(context);\n146: this.release();"}]}]},{"id":5,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":"c2","toolName":"read","isError":false,"content":[{"type":"text","text":"export async function openSessionStorage(...)"}]}]},{"id":6,"kind":"pi.assistant","model":[{"role":"assistant","stopReason":"toolUse","content":[{"type":"text","text":"## Root cause\n\nThe lease is released **after** `adapter.close()`, but the test reopens as soon as `harness.close()` resolves. Two things race:\n\n1. The SQLite lease is still held by the closing worker.\n2. `openSessionStorage` fails fast with `timeout: 0`.\n\nThe fix is to wait for the previous owner, bounded:\n\n```ts\nwhile (!owned) {\n  try {\n    owned = await openSessionStorage(dir);\n  } catch (error) {\n    if (!(error instanceof StorageBusy) || Date.now() > deadline) throw error;\n    await sleep(25);\n  }\n}\n```"},{"type":"toolCall","id":"c3","name":"applyPatch","arguments":{"patch":"*** Begin Patch\n*** Update File: packages/kernel/src/session.ts\n@@\n-const owned = await openSessionStorage(spec.storageDir);\n+const owned = await openWithRetry(spec.storageDir);\n*** End Patch"}}]}]},{"id":7,"kind":"pi.tool-result","model":[{"role":"toolResult","toolCallId":"c3","toolName":"applyPatch","isError":false,"content":[{"type":"text","text":"Updated packages/kernel/src/session.ts"}]}]},{"id":8,"kind":"pi.user","model":[{"role":"user","content":"Also run the kernel tests."}]}],"tools":[],"compactions":[],"inbox":[],"agent":{},"usage":{},"run":{"inputs":[8]}},
        {"type":"message_start","message":{"role":"assistant","content":[]}},
        {"type":"message_update","changes":[{"type":"text_start","contentIndex":0,"block":{"type":"text","text":"Running the kernel tests now."}}]},
        {"type":"message_update","changes":[{"type":"toolcall_start","contentIndex":1,"block":{"type":"toolCall","id":"c4","name":"codemode","arguments":{"code":"text(await tools.bash({command:\"npm test -- packages/kernel\"}));"}}}]},
        {"type":"tool_execution_start","toolCallId":"c4","toolName":"codemode","args":{}},
        {"type":"tool_execution_update","toolCallId":"c4","toolName":"codemode","output":{"append":"> node --import tsx --test 'packages/*/src/**/*.test.ts'\n✔ creates, updates, persists and removes projects\n"}}
        ]
        """#
        if let parsed = try? JSONValue.decode(Data(events.utf8)), let list = parsed.array { transcript.apply(list) }
        let todos = #"""
        {"type":"todos_update","items":[
          {"id":"TODO-deadbeef","title":"Fix the storage lease race","status":"closed","createdAt":"2026-07-01"},
          {"id":"TODO-cafebabe","title":"Run kernel tests and verify reopening","status":"open","createdAt":"2026-07-02","assignedToSession":"\#(sessions[0].id)"},
          {"id":"TODO-01234567","title":"Add regression coverage for worker recovery","status":"open","createdAt":"2026-07-03"}
        ]}
        """#
        if let parsed = try? JSONValue.decode(Data(todos.utf8)) { transcript.apply(parsed) }
        return transcript
    }
}
