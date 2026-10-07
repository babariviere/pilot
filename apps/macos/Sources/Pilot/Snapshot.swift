import AppKit
import GhosttyTerminal
import PilotCore
import SwiftUI

/// `Pilot --snapshot <dir>` renders the main screens offscreen with fixture data, as PNGs, and quits.
/// Used to review the UI without screen-recording permission or a live daemon.
@MainActor
enum Snapshot {
    static func runIfRequested() -> Bool {
        let arguments = CommandLine.arguments
        if arguments.contains("--queue-edit-test") {
            Task { await QueueEditingTest.run() }
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
        model.client.fixtureModels = ModelList(
            models: [
                ModelOption(id: "anthropic/claude-opus-5-5", provider: "anthropic", name: "Claude Opus 5.5"),
                ModelOption(id: "openai-codex/gpt-6.1-sol", provider: "openai-codex", name: "GPT-6.1 Sol"),
            ],
            defaultModel: "openai-codex/gpt-6.1-sol"
        )
        model.daemon.markRunningForSnapshot()
        let size = CGSize(width: 1360, height: 860)

        model.selectedSessionId = nil
        await render(Frame(title: "Pilot", subtitle: nil) { HomeView() }, size: size, to: directory.appending(path: "home.png"))

        let session = Fixtures.sessions[0]
        model.selectedSessionId = session.id
        let feed = SessionFeed(sessionId: session.id, transcript: Fixtures.transcript)
        await render(
            Frame(title: session.title, subtitle: "pilot · \(session.model ?? "")") {
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
        await render(SettingsView().environmentObject(model), size: CGSize(width: 560, height: 420), to: directory.appending(path: "settings.png"))
        await render(
            VStack(alignment: .leading, spacing: 16) {
                UsageFooter(usage: Fixtures.codexUsage)
                UsageFooter(usage: Fixtures.claudeUsage)
                UsageFooter(usage: SessionUsage(
                    context: ContextUsage(contextWindow: 200_000),
                    subscription: SubscriptionUsage(fetchedAt: Fixtures.now - 3_600_000, provider: .anthropic,
                                                    windows: [], error: "Could not refresh subscription limits")
                ))
                UsageFooter(usage: SessionUsage(subscription: SubscriptionUsage(fetchedAt: Fixtures.now, provider: .openai, windows: [])))
            }
            .padding(.vertical, 16)
            .background(Theme.background),
            size: CGSize(width: 760, height: 220),
            to: directory.appending(path: "usage-footers.png")
        )
        await render(
            VStack(spacing: 16) {
                UsageFooter(usage: Fixtures.codexUsage)
                UsageFooter(usage: Fixtures.claudeUsage)
                UsageFooter(usage: SessionUsage(
                    context: ContextUsage(tokens: 0, contextWindow: 200_000),
                    subscription: SubscriptionUsage(fetchedAt: Fixtures.now, windows: [])
                ))
            }
            .padding(.vertical, 16)
            .background(Theme.background),
            size: CGSize(width: 360, height: 220),
            to: directory.appending(path: "usage-footer-narrow.png")
        )
        for (name, working) in [("menubar-idle", false), ("menubar-working", true)] {
            let image = PlaneImage.menuBar(working: working)
            let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 72, pixelsHigh: 72, bitsPerSample: 8,
                                       samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                       bytesPerRow: 0, bitsPerPixel: 0)!
            rep.size = image.size
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
            image.draw(in: NSRect(origin: .zero, size: image.size))
            NSGraphicsContext.restoreGraphicsState()
            try? rep.representation(using: .png, properties: [:])?.write(to: directory.appending(path: "\(name).png"))
        }
        print("snapshots written to \(directory.path)")
        exit(0)
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

    private static func render<V: View>(_ view: V, size: CGSize, to url: URL) async {
        let root = view
            .environmentObject(AppModel.shared)
            .environment(\.pilotFonts, AppSettings.shared.fonts)
            .frame(width: size.width, height: size.height)
        let hosting = NSHostingView(rootView: root)
        hosting.frame = CGRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: .aqua)
        window.contentView = hosting
        window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
        window.orderFrontRegardless()
        // Let lists, lazy stacks, images and async loads settle. Sleeping (not spinning the run loop)
        // lets other main-actor work, such as a pane's load, run meanwhile.
        for _ in 0 ..< 8 {
            hosting.layoutSubtreeIfNeeded()
            try? await Task.sleep(for: .milliseconds(100))
        }
        // 1x output keeps review images small.
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: Int(size.width), pixelsHigh: Int(size.height), bitsPerSample: 8,
            samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ) else { return }
        rep.size = size
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
        window.orderOut(nil)
    }

    /// Sidebar plus a stand-in for the window toolbar.
    private struct Frame<Content: View>: View {
        let title: String
        let subtitle: String?
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
                            if let subtitle { Text(subtitle).font(.system(size: 11)).foregroundStyle(Theme.mutedForeground) }
                        }
                        Spacer()
                        if subtitle != nil {
                            StateBadge(state: "working")
                            Image(systemName: "folder").foregroundStyle(Theme.mutedForeground)
                            Image(systemName: "terminal").foregroundStyle(Theme.mutedForeground)
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

    static let sessions = [
        SessionSummary(id: "s1", title: "Fix flaky reopen test in kernel session", cwd: projects[0].path, projectId: "p1",
                       branch: "pilot/fix-flaky-reopen-test-55cb84",
                       createdAt: now - 3_600_000, updatedAt: now - 133_000, state: "working", model: "openai-codex/gpt-6.1-sol",
                       usage: codexUsage),
        SessionSummary(id: "s2", title: "Add projects API to pilotd", cwd: projects[0].path, projectId: "p1",
                       createdAt: now - 86_400_000, updatedAt: now - 3_000_000, state: "idle", model: "openai-codex/gpt-6.1-sol"),
        SessionSummary(id: "s3", title: "Review subagents durable storage", cwd: projects[1].path, projectId: "p2",
                       createdAt: now - 2 * 86_400_000, updatedAt: now - 600_000, state: "working", model: "anthropic/claude-opus-5-5",
                       usage: claudeUsage),
        SessionSummary(id: "s4", title: "Sandbox floor for night runs", cwd: projects[1].path, projectId: "p2",
                       createdAt: now - 4 * 86_400_000, updatedAt: now - 90_000_000, state: "failed", model: "anthropic/claude-sonnet-5",
                       error: "Kernel exited with code 1"),
        SessionSummary(id: "s5", title: "Explain the Harness task graph", cwd: "\(home)/scratch",
                       createdAt: now - 6 * 86_400_000, updatedAt: now - 400_000_000, state: "parked"),
    ]

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
        return transcript
    }
}
