import AppKit
import PilotCore
import SwiftUI

/// Pilot's icon vocabulary: one SF Symbol per concept, named for what it means rather than how it looks.
///
/// Use `PilotSymbol` and `Label(_:icon:)` with a case below instead of `systemName` strings, and size
/// icons with `PilotIcon.Context` for their context. Colour stays with the caller (state colours live in
/// `Theme`). Add a missing concept here, with a one-line note on its use, rather than picking a symbol
/// on a single screen.
///
/// Style rules:
/// - Outline by default. Only the cases with a `stateFillName` fill, and only while their state holds
///   (selected navigation, a pinned chat, a terminal success, a failure, an open question).
/// - `alwaysFilledIcons` are the deliberate exceptions whose one symbol is filled (a platform clear button,
///   the stop glyph on a filled control, the half and three-quarter progress marks).
/// - Status ladder for Linear tickets and mission tasks: `todo` (empty), `inProgress` (half), `inReview`
///   (three quarters, drawn by `ReviewQuarterGlyph`), then `complete`.
/// - Each concept has its own symbol. `sharedSymbols` lists the only intended overlaps.
/// - Brand and Git marks are not SF Symbols; use `PilotMark` so services stay recognisable.
///
/// Each case documents its intended use in `usage`.
enum PilotIcon: String, CaseIterable {
    // MARK: Places and navigation

    case home, inbox, overview, allProjects, project, chatFolder, mission, coordinator, artifact, image, settings,
        archive, restore, search, filter, back, focusProject, inspector

    // MARK: Actions

    case compose, add, addTo, remove, delete, dismiss, clearField, more, edit, copy, share, openExternal, refresh,
        send, stop, pin, unpin, newProject

    // MARK: Disclosure and selection

    case disclosure, disclosureOpen, collapse, popUp, selectedOption

    // MARK: Status

    case done, complete, warning, blocked, info, question, stopped, paused, idle, cancelled, pending, todo, inProgress,
        inReview, draft, unset, working, scheduled, scheduleFailed

    // MARK: Conversation and mission

    case chats, message, update, resolvedComment, quote, recipient, handoff, proposal, steer, queued, unsentDraft,
        tasks, phase, status, decision, claim, addMember, skill

    // MARK: Agents, tools and workspaces

    case askMode, buildMode, subagents, model, thinking, memory, memoryEntry, command, code, web, extensionTool, tool, terminal,
        changes, link, document, isolatedWorkspace, sharedWorkspace, compaction, reset, push, pullRequest, branch, bug

    // MARK: Services and settings

    case linearIssue, githubIssue, slackChannel, privateChannel, signInRequired, appearance, notifications, energy,
        power, updates, activity, connections
}

extension PilotIcon {
    /// The outline (default) SF Symbol name, or nil for work and Git marks, which have their own renderers.
    var systemName: String? {
        switch self {
        case .home: "house"
        case .inbox: "tray"
        case .overview: "square.grid.2x2"
        case .allProjects: "square.stack"
        case .project: "folder"
        case .chatFolder: "folder"
        case .mission: "map"
        case .coordinator: "safari"
        case .artifact: "rectangle.on.rectangle.angled"
        case .image: "photo"
        case .settings: "gearshape"
        case .archive: "archivebox"
        case .restore: "arrow.uturn.backward"
        case .search: "magnifyingglass"
        case .filter: "line.3.horizontal.decrease.circle"
        case .back: "chevron.left"
        case .focusProject: "sidebar.left"
        case .inspector: "sidebar.right"
        case .compose: "square.and.pencil"
        case .add: "plus"
        case .addTo: "plus.circle"
        case .remove: "minus.circle"
        case .delete: "trash"
        case .dismiss: "xmark"
        case .clearField: "xmark.circle.fill"
        case .more: "ellipsis"
        case .edit: "pencil"
        case .copy: "doc.on.doc"
        case .share: "square.and.arrow.up"
        case .openExternal: "arrow.up.right"
        case .refresh: "arrow.clockwise"
        case .send: "arrow.up"
        case .stop: "stop.fill"
        case .pin: "pin"
        case .unpin: "pin.slash"
        case .newProject: "folder.badge.plus"
        case .disclosure: "chevron.right"
        case .disclosureOpen: "chevron.down"
        case .collapse: "chevron.up"
        case .popUp: "chevron.up.chevron.down"
        case .selectedOption: "circle.inset.filled"
        case .done: "checkmark"
        case .complete: "checkmark.circle"
        case .warning: "exclamationmark.triangle"
        case .blocked: "exclamationmark.octagon"
        case .info: "info.circle"
        case .question: "questionmark.bubble"
        case .stopped: "stop.circle"
        case .paused: "pause.circle"
        case .idle: "moon.zzz"
        case .cancelled: "xmark.circle"
        case .pending: "clock"
        case .todo: "circle"
        case .inProgress: "circle.lefthalf.filled"
        case .draft: "pencil.circle"
        case .unset: "circle.dotted"
        case .working, .pullRequest, .branch, .inReview: nil
        case .scheduled: "calendar.badge.clock"
        case .scheduleFailed: "calendar.badge.exclamationmark"
        case .chats: "bubble.left.and.bubble.right"
        case .message: "bubble.left"
        case .update: "text.bubble"
        case .resolvedComment: "checkmark.bubble"
        case .quote: "text.quote"
        case .recipient: "arrowshape.turn.up.right"
        case .handoff: "arrow.right.circle"
        case .proposal: "arrow.right"
        case .steer: "arrow.turn.down.right"
        case .queued: "clock.arrow.circlepath"
        case .unsentDraft: "pencil.line"
        case .tasks: "checklist"
        case .phase: "signpost.right"
        case .status: "flag"
        case .decision: "checkmark.seal"
        case .claim: "hand.raised"
        case .addMember: "person.badge.plus"
        case .skill: "sparkles"
        case .askMode: "eye"
        case .buildMode: "hammer"
        case .subagents: "person.2"
        case .model: "cpu"
        case .thinking: "brain"
        case .memory: "brain.head.profile"
        case .memoryEntry: "circle"
        case .command: "command"
        case .code: "curlybraces"
        case .web: "globe"
        case .extensionTool: "puzzlepiece.extension"
        case .tool: "wrench.and.screwdriver"
        case .terminal: "terminal"
        case .changes: "plusminus"
        case .link: "link"
        case .document: "doc.text"
        case .isolatedWorkspace: "square.on.square"
        case .sharedWorkspace: "square.stack.3d.up"
        case .compaction: "arrow.down.right.and.arrow.up.left"
        case .reset: "eraser"
        case .push: "arrow.up.to.line"
        case .bug: "ladybug"
        case .linearIssue: "list.bullet.rectangle"
        case .githubIssue: "exclamationmark.bubble"
        case .slackChannel: "number"
        case .privateChannel: "lock"
        case .signInRequired: "person.crop.circle.badge.exclamationmark"
        case .appearance: "textformat"
        case .notifications: "bell"
        case .energy: "leaf"
        case .power: "powerplug"
        case .updates: "arrow.down.circle"
        case .activity: "chart.bar"
        case .connections: "point.3.connected.trianglepath.dotted"
        }
    }

    /// The filled symbol shown while the icon's state holds, or nil when the icon never fills.
    var stateFillName: String? {
        switch self {
        case .home, .inbox, .overview, .pin, .complete, .warning, .question, .memoryEntry: systemName.map { $0 + ".fill" }
        default: nil
        }
    }

    /// The state that fills the icon, for documentation and the icon sheet.
    var fillState: String? {
        switch self {
        case .home: "selected"
        case .inbox: "selected"
        case .overview: "selected"
        case .pin: "pinned"
        case .complete: "complete"
        case .warning: "failed"
        case .question: "asked"
        case .memoryEntry: "current"
        default: nil
        }
    }

    /// Icons whose only symbol is filled. See the type notes for why each one is an exception.
    static let alwaysFilledIcons: Set<PilotIcon> = [.clearField, .stop, .inProgress, .inReview, .selectedOption]

    /// The only concepts that intentionally share a symbol.
    static let sharedSymbols: [String: [PilotIcon]] = [
        "circle": [.todo, .memoryEntry],
        // Both are folder containers; use the baseline mark rather than a newer-OS-only variant.
        "folder": [.project, .chatFolder],
    ]

    /// The symbol name for the current state. `filled` only applies to icons with a `stateFillName`.
    func systemName(filled: Bool) -> String? {
        filled ? stateFillName ?? systemName : systemName
    }

    /// Native SF symbol for TextKit attachments. Live and custom concepts use their own renderers.
    @MainActor func symbolImage(context: Context = .inline) -> NSImage? {
        guard let name = systemName else { return nil }
        return NSImage(systemSymbolName: name, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: context.role.size, weight: context.nsWeight))
    }

    /// Where the concept is meant to appear.
    var usage: String {
        switch self {
        case .home: "Home in the sidebar. Fills while selected."
        case .inbox: "Inbox, and lists that collect items for the user (Linear and Slack, triage). Fills while selected."
        case .overview: "A project's Overview. Fills while selected."
        case .allProjects: "The All projects scope, and Show All Projects."
        case .project: "A project, a working directory or a direct checkout."
        case .chatFolder: "A user folder that groups projects in the project picker and on Home, and New Folder. Shares the project folder mark for OS compatibility."
        case .mission: "A mission, everywhere one appears."
        case .coordinator: "A mission's coordinator chat."
        case .artifact: "An artifact; image artifacts use image."
        case .image: "An image, an image artifact or an attachment."
        case .settings: "Settings for a project or integration."
        case .archive: "Archive an item, or open archived chats."
        case .restore: "Undo a state: unarchive, reopen or rewind."
        case .search: "Search a list or field."
        case .filter: "A filter, or a list emptied by its filters."
        case .back: "Go back to the parent page."
        case .focusProject: "Focus the sidebar on one project."
        case .inspector: "Show or hide the inspector."
        case .compose: "Start a new chat (the sidebar compose button)."
        case .add: "Add or create an item in place."
        case .addTo: "Add an existing item to a collection, such as a chat to a mission."
        case .remove: "Remove an item from a collection without deleting it."
        case .delete: "Delete permanently. Pair with a destructive hover tint."
        case .dismiss: "Close a pane, dismiss a banner or cancel an inline edit."
        case .clearField: "Clear a search field or remove an attachment. Filled by platform convention."
        case .more: "A menu of secondary actions."
        case .edit: "Edit or rename in place."
        case .copy: "Copy to the pasteboard. Swap to done while confirming."
        case .share: "Share or export."
        case .openExternal: "Open in the browser or another app."
        case .refresh: "Reload, or retry a failed step."
        case .send: "Send a message or post, inside the circular composer button."
        case .stop: "Stop the running agent, inside the circular composer button. Filled because it sits on a filled control."
        case .pin: "Pin a chat. Fills while pinned."
        case .unpin: "Unpin a chat."
        case .newProject: "Add a project."
        case .disclosure: "A closed disclosure, or a row that navigates."
        case .disclosureOpen: "An open disclosure, or Show more."
        case .collapse: "Show less, or fold a panel that expanded upward."
        case .popUp: "Trailing mark of a pop-up chip or switcher."
        case .selectedOption: "The chosen option in a menu or picker. Filled selection circle, not a completion checkmark."
        case .done: "Copy confirmation and fired schedules only. Finished tool steps have no symbol."
        case .complete: "Success that matters: ready to merge, all clear, a connected MCP server. May fill for terminal success, never as a badge."
        case .warning: "A warning, an error banner or an invalid item. Fills when something failed."
        case .blocked: "Blocked work: a blocked task or a pull request blocked from merging."
        case .info: "Neutral information."
        case .question: "An agent or mission question, and Slack questions. Fills while it waits for the user."
        case .stopped: "A chat the user stopped."
        case .paused: "Paused work, such as a paused queue."
        case .idle: "Idle or paused agents, and energy pauses."
        case .cancelled: "Cancelled or dropped: a cancelled schedule, a dropped task, a canceled issue."
        case .pending: "Waiting on time: pending checks, durations and timelines."
        case .todo: "Not started yet."
        case .inProgress: "Started work. The half fill is the meaning, not a state toggle."
        case .inReview: "Waiting on review. Three quarters filled, between inProgress and complete; drawn by ReviewQuarterGlyph."
        case .draft: "A draft pull request or a decision proposal."
        case .unset: "No state yet: a running tool, an unknown event, no mission health."
        case .working: "Live work uses the shared EllipsisSpinner (three dots), never an SF Symbol or a braille spinner."
        case .scheduled: "A scheduled item."
        case .scheduleFailed: "A scheduled item that could not start."
        case .chats: "A list of chats or channels."
        case .message: "One chat or one Slack message."
        case .update: "An update, an open comment or a prompt template."
        case .resolvedComment: "A resolved comment."
        case .quote: "Quote or comment on a passage."
        case .recipient: "Who a comment or message goes to."
        case .handoff: "A handoff note or delegated work."
        case .proposal: "A proposed change in a decision."
        case .steer: "A steering message, or an item that moves to another place."
        case .queued: "A queued follow-up."
        case .unsentDraft: "A chat's unsent composer text, leading its list rows' second line. Never a badge or a colour."
        case .tasks: "Mission tasks or the agent's todo list."
        case .phase: "A mission phase: the stage a task belongs to."
        case .status: "A mission status change."
        case .decision: "A recorded decision."
        case .claim: "A claimed task, or a Slack request."
        case .addMember: "A member joined."
        case .skill: "A skill, or something newly created."
        case .askMode: "An Ask (read-only) chat or workspace."
        case .buildMode: "A Build chat."
        case .subagents: "Subagents and audiences."
        case .model: "A model picker or model name."
        case .thinking: "The thinking level."
        case .memory: "Project memory."
        case .memoryEntry: "A memory entry. Fills while current; replaced entries stay outlined."
        case .command: "A Pilot slash command."
        case .code: "Structured tool input or output."
        case .web: "Web fetches and searches."
        case .extensionTool: "An MCP or extension tool."
        case .tool: "Any other tool call."
        case .terminal: "The terminal, shell commands and background jobs."
        case .changes: "The Changes inspector."
        case .link: "A generic link. Known services use PilotMark."
        case .document: "A file, the mission brief or a read tool."
        case .isolatedWorkspace: "An isolated workspace clone."
        case .sharedWorkspace: "A workspace shared between chats."
        case .compaction: "Context was compacted."
        case .reset: "Context was reset."
        case .push: "Commits were pushed."
        case .pullRequest: "Pull requests use only PilotMark, including events and notifications."
        case .branch: "Branches use only PilotMark, including events, forks and the branch picker."
        case .bug: "A bug report or the debug session."
        case .linearIssue: "Fallback for a Linear item without its mark."
        case .githubIssue: "Fallback for a GitHub issue without its mark."
        case .slackChannel: "A public Slack channel."
        case .privateChannel: "A private channel or a locked item."
        case .signInRequired: "An integration that needs the user to sign in."
        case .appearance: "Appearance settings."
        case .notifications: "Notification settings."
        case .energy: "Energy settings and low-power state."
        case .power: "Power-adapter conditions."
        case .updates: "App updates."
        case .activity: "Activity charts."
        case .connections: "Connections settings: the pi MCP servers chats use."
        }
    }
}

// MARK: - Contexts

extension PilotIcon {
    /// One size and weight per place an icon sits, from the `Theme.TextRole` scale.
    /// `Label` icons use the row context without changing their text font.
    ///
    /// - row: the leading symbol of a list row or nav row, in a 16 pt column so titles align.
    /// - toolbar: icon-only buttons in headers, toolbars and row trailing actions (`QuietIconButtonStyle`).
    /// - inline: symbols inside text runs, chips, pills, section labels and metadata lines.
    /// - emptyState: the faint symbol above an empty pane (`EmptyStateView`).
    /// - disclosure: small structural chevrons, not content or action icons.
    enum Context: CaseIterable {
        case row, toolbar, inline, emptyState, disclosure

        var role: Theme.TextRole {
            switch self {
            case .row, .toolbar: .label
            case .inline: .caption
            case .emptyState: .title
            case .disclosure: .micro
            }
        }

        var weight: Font.Weight {
            switch self {
            case .toolbar: .medium
            case .disclosure: .semibold
            case .row, .inline, .emptyState: .regular
            }
        }

        /// `weight` for AppKit symbol images, such as `ReviewQuarterGlyph`.
        var nsWeight: NSFont.Weight {
            switch self {
            case .toolbar: .medium
            case .disclosure: .semibold
            case .row, .inline, .emptyState: .regular
            }
        }

        var font: Font { .pilot(role, weight: weight) }

        /// Fixed column width, so leading row symbols of different shapes align.
        var frameWidth: CGFloat? {
            switch self {
            case .row: 16
            case .toolbar, .inline, .emptyState, .disclosure: nil
            }
        }

        /// Side of a `PilotMark` in this context, matched optically to the symbol size.
        var markSize: CGFloat {
            switch self {
            case .row, .toolbar: 12
            case .inline: 11
            case .emptyState: 22
            case .disclosure: 9
            }
        }
    }
}

/// One vocabulary symbol, sized independently of surrounding text. Caller-owned frames and spacing stay put.
struct PilotSymbol: View {
    let icon: PilotIcon
    var filled: Bool
    var context: PilotIcon.Context

    init(_ icon: PilotIcon, filled: Bool = false, context: PilotIcon.Context = .inline) {
        assert(!filled || icon.stateFillName != nil, "\(icon) has no state fill")
        self.icon = icon
        self.filled = filled
        self.context = context
    }

    var body: some View {
        if icon == .working {
            EllipsisSpinner()
                .scaleEffect(context.markSize / EllipsisDots.side)
                .frame(width: context.markSize, height: context.markSize)
                .accessibilityLabel("Working").accessibilityHidden(false)
        } else if icon == .branch || icon == .pullRequest {
            PilotMarkIcon(mark: .gitBranch, context: context)
        } else if icon == .inReview {
            Image(nsImage: ReviewQuarterGlyph.image(context))
                .renderingMode(.template)
                .accessibilityLabel("In review")
        } else if let name = icon.systemName(filled: filled) {
            Image(systemName: name).font(context.font)
        }
    }
}

/// The in-review step of the status ladder: the `circle` outline filled clockwise from 12 o'clock to 9 o'clock,
/// leaving the top-left quarter empty. SF Symbols has no three-quarter circle, so this composes `circle` and
/// `circle.fill` at the context's size and weight, matching `todo` and `inProgress` stroke for stroke.
/// It is an image rather than a view so it also shows in menus.
@MainActor enum ReviewQuarterGlyph {
    private static var cache: [PilotIcon.Context: NSImage] = [:]

    static func image(_ context: PilotIcon.Context) -> NSImage {
        if let image = cache[context] { return image }
        let image = draw(pointSize: context.role.size, weight: context.nsWeight)
        cache[context] = image
        return image
    }

    /// Nonisolated so the drawing handler, which AppKit may call off the main thread, carries no actor.
    nonisolated static func draw(pointSize: CGFloat, weight: NSFont.Weight) -> NSImage {
        let configuration = NSImage.SymbolConfiguration(pointSize: pointSize, weight: weight)
            .applying(NSImage.SymbolConfiguration(paletteColors: [.black]))
        guard let outline = NSImage(systemSymbolName: "circle", accessibilityDescription: nil)?
            .withSymbolConfiguration(configuration),
            let disc = NSImage(systemSymbolName: "circle.fill", accessibilityDescription: nil)?
            .withSymbolConfiguration(configuration)
        else { return NSImage() }
        let image = NSImage(size: outline.size, flipped: false) { rect in
            outline.draw(in: rect)
            NSGraphicsContext.saveGraphicsState()
            // The right half plus the bottom-left quarter: 270° clockwise from 12 o'clock.
            let pie = NSBezierPath(rect: NSRect(x: rect.midX, y: rect.minY, width: rect.width / 2, height: rect.height))
            pie.append(NSBezierPath(rect: NSRect(x: rect.minX, y: rect.minY, width: rect.width / 2, height: rect.height / 2)))
            pie.addClip()
            disc.draw(in: NSRect(x: rect.midX - disc.size.width / 2, y: rect.midY - disc.size.height / 2,
                                 width: disc.size.width, height: disc.size.height))
            NSGraphicsContext.restoreGraphicsState()
            return true
        }
        image.isTemplate = true
        return image
    }
}

extension Label where Title == Text, Icon == PilotSymbol {
    /// Labels share the row icon size; the label's text keeps its own typography.
    @MainActor init<S: StringProtocol>(_ title: S, icon: PilotIcon) {
        self.init { Text(String(title)) } icon: { PilotSymbol(icon, context: .row) }
    }
}

// MARK: - Marks

/// Monochrome template marks that are not SF Symbols. They are the exceptions to the vocabulary: SF Symbols
/// has no service logos, and Pilot's Git marks follow GitHub's octicons so pull requests read as GitHub's.
///
/// - github, linear, slack: `BrandMark`, for links to those services. Never recolour with brand colours.
/// - gitBranch: the branch picker and open pull requests (`GitBranchGlyph`).
/// - pullRequestMerged, pullRequestClosed: terminal pull request states (`PullRequestGlyph`, octicons).
///
/// Other custom images are artwork or animation, not icons, and stay outside this file: the plane app and
/// menu bar icon (`PlaneImage`), the working spinner (`EllipsisSpinner`), dithered art (`DitherSky`,
/// `DitherScene`, `DitherCorner`) and image attachment previews.
enum PilotMark: CaseIterable {
    case github, linear, slack, gitBranch, pullRequestMerged, pullRequestClosed

    @MainActor var image: NSImage {
        switch self {
        case .github: BrandMark.github.image
        case .linear: BrandMark.linear.image
        case .slack: BrandMark.slack.image
        case .gitBranch: GitBranchGlyph.image
        case .pullRequestMerged: PullRequestGlyph.merged.image
        case .pullRequestClosed: PullRequestGlyph.closed.image
        }
    }

    var accessibilityName: String {
        switch self {
        case .github: "GitHub"
        case .linear: "Linear"
        case .slack: "Slack"
        case .gitBranch: "Branch"
        case .pullRequestMerged: "Merged"
        case .pullRequestClosed: "Closed"
        }
    }
}

/// A `PilotMark` sized for a context, tinted by the foreground style like an SF Symbol.
struct PilotMarkIcon: View {
    let mark: PilotMark
    var context: PilotIcon.Context = .inline

    var body: some View {
        Image(nsImage: mark.image)
            .renderingMode(.template)
            .resizable()
            .interpolation(.high)
            .frame(width: context.markSize, height: context.markSize)
            .accessibilityLabel(mark.accessibilityName)
    }
}

// Tool summaries cross the UI boundary as meanings, never SF Symbol names.
extension ToolIcon {
    var pilotIcon: PilotIcon {
        switch self {
        case .terminal: .terminal
        case .code: .code
        case .document: .document
        case .edit: .edit
        case .search: .search
        case .web: .web
        case .subagents: .subagents
        case .extensionTool: .extensionTool
        case .tool: .tool
        }
    }
}

extension PilotMark {
    init?(_ kind: MissionResourceKind) {
        guard let mark = BrandMark(kind) else { return nil }
        switch mark {
        case .github: self = .github
        case .linear: self = .linear
        case .slack: self = .slack
        }
    }
}
