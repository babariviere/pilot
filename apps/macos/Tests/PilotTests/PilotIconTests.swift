import AppKit
import PilotCore
import Testing
@testable import Pilot

@Test @MainActor func vocabularySymbolsResolveOnThisSystem() {
    for icon in PilotIcon.allCases {
        if let name = icon.systemName {
            #expect(NSImage(systemSymbolName: name, accessibilityDescription: nil) != nil,
                    "Missing symbol for \(icon): \(name)")
        } else {
            #expect([PilotIcon.working, .branch, .pullRequest, .inReview].contains(icon))
        }
        #expect(!icon.usage.isEmpty)
        if let fill = icon.stateFillName {
            #expect(NSImage(systemSymbolName: fill, accessibilityDescription: nil) != nil,
                    "Missing state symbol for \(icon): \(fill)")
            #expect(icon.fillState != nil)
            #expect(icon.systemName(filled: true) == fill)
        } else {
            #expect(icon.fillState == nil)
            #expect(icon.systemName(filled: true) == icon.systemName)
        }
    }
}

@Test func vocabularyOnlySharesExplicitlyDocumentedSymbols() {
    let groups = Dictionary(grouping: PilotIcon.allCases.filter { $0.systemName != nil }, by: { $0.systemName! })
    let shared = groups.filter { $0.value.count > 1 }
    #expect(Set(shared.keys) == Set(PilotIcon.sharedSymbols.keys))
    for (name, icons) in shared {
        #expect(Set(icons) == Set(PilotIcon.sharedSymbols[name] ?? []))
    }
}

@Test func chatFolderUsesTheBaselineFolderSymbol() {
    // text.below.folder resolves on macOS 27 but not on the older CI runtime.
    #expect(PilotIcon.chatFolder.systemName == "folder")
    #expect(PilotIcon.sharedSymbols["folder"] == [.project, .chatFolder])
}

@Test func vocabularyFillExceptionsAreExplicitAndBounded() {
    let stateful: Set<PilotIcon> = [.home, .inbox, .overview, .pin, .complete, .warning, .question, .memoryEntry]
    #expect(Set(PilotIcon.allCases.filter { $0.stateFillName != nil }) == stateful)
    let alwaysFilled = Set(PilotIcon.allCases.filter {
        ($0.systemName?.contains(".fill") ?? false) || ($0.systemName?.contains("filled") ?? false)
    })
    // The three-quarter review mark is custom-drawn, so it has no symbol name to inspect.
    #expect(alwaysFilled.union([.inReview]) == PilotIcon.alwaysFilledIcons)
    #expect(stateful.isDisjoint(with: alwaysFilled))
}

@Test @MainActor func statusLadderEndsWithAThreeQuarterReviewMark() {
    #expect(PilotIcon.todo.systemName == "circle")
    #expect(PilotIcon.inProgress.systemName == "circle.lefthalf.filled")
    #expect(PilotIcon.inReview.systemName == nil)
    #expect(MissionTaskStatus.inReview.icon == .inReview)
    for context in PilotIcon.Context.allCases {
        let mark = ReviewQuarterGlyph.image(context)
        #expect(mark.isTemplate)
        #expect(mark.size.width > 0 && mark.size.height > 0)
        #expect(ReviewQuarterGlyph.image(context) === mark)
    }
    // Same frame as the outline it is drawn from, so it lines up with todo and inProgress.
    let outline = NSImage(systemSymbolName: "circle", accessibilityDescription: nil)?
        .withSymbolConfiguration(.init(pointSize: Theme.TextRole.label.size, weight: .regular))
    #expect(ReviewQuarterGlyph.image(.row).size == outline?.size)
}

@Test @MainActor func reviewQuarterLeavesOnlyTheTopLeftQuarterEmpty() throws {
    let mark = ReviewQuarterGlyph.draw(pointSize: 64, weight: .regular)
    let bitmap = try #require(NSBitmapImageRep(data: try #require(mark.tiffRepresentation)))
    let (width, height) = (bitmap.pixelsWide, bitmap.pixelsHigh)
    func alpha(_ x: Double, _ y: Double) -> CGFloat {
        // Bitmap rows run top to bottom.
        bitmap.colorAt(x: Int(Double(width) * x), y: Int(Double(height) * y))?.alphaComponent ?? 0
    }
    #expect(alpha(0.35, 0.35) < 0.1, "top-left quarter is empty")
    #expect(alpha(0.65, 0.35) > 0.9, "top-right quarter is filled")
    #expect(alpha(0.65, 0.65) > 0.9, "bottom-right quarter is filled")
    #expect(alpha(0.35, 0.65) > 0.9, "bottom-left quarter is filled")
}

@Test func vocabularyContextSizesFollowThemeScale() {
    #expect(PilotIcon.Context.row.role == .label)
    #expect(PilotIcon.Context.toolbar.role == .label)
    #expect(PilotIcon.Context.inline.role == .caption)
    #expect(PilotIcon.Context.emptyState.role == .title)
    #expect(PilotIcon.Context.disclosure.role == .micro)
    #expect(PilotIcon.Context.row.frameWidth == 16)
    for context in PilotIcon.Context.allCases {
        #expect(context.markSize == context.role.size)
    }
}

@Test func toolSummaryIconsCrossTheCoreBoundaryAsMeanings() {
    #expect(ToolSummary(name: "bash", arguments: .object([:])).icon.pilotIcon == .terminal)
    #expect(ToolSummary(name: "read", arguments: .object([:])).icon.pilotIcon == .document)
    #expect(ToolSummary(name: "applyPatch", arguments: .object([:])).icon.pilotIcon == .edit)
    #expect(ToolSummary(name: "mcp__example", arguments: .object([:])).icon.pilotIcon == .extensionTool)
    #expect(Set(ToolIcon.allCases.map(\.pilotIcon)).count == ToolIcon.allCases.count)
}

@Test func liveWorkAndGitConceptsHaveNoSfDuplicates() {
    #expect(PilotIcon.working.systemName == nil)
    #expect(PilotIcon.branch.systemName == nil)
    #expect(PilotIcon.pullRequest.systemName == nil)
    #expect(PilotIcon.reset.systemName != PilotIcon.refresh.systemName)
    #expect(PilotIcon.reset.systemName != PilotIcon.restore.systemName)
    #expect(PilotIcon.selectedOption.systemName != PilotIcon.done.systemName)
}

@Test func sfSymbolConstructionStaysInTheVocabulary() throws {
    let sources = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Sources")
    let files = try #require(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
    for case let file as URL in files where file.pathExtension == "swift" && file.lastPathComponent != "PilotIcon.swift" {
        let source = try String(contentsOf: file, encoding: .utf8)
        #expect(!source.contains("Image(systemName:"), "Use PilotSymbol in \(file.lastPathComponent)")
        #expect(source.range(of: #"Label\([^{}]*systemImage:"#, options: .regularExpression) == nil,
                "Use Label(_:icon:) in \(file.lastPathComponent)")
        #expect(!source.contains("systemSymbolName:"), "Keep SF name resolution in PilotIcon.swift: \(file.lastPathComponent)")
        #expect(!source.contains("MissionSymbol"))
        #expect(!source.contains("ArtifactSymbol"))
        #expect(!source.contains("WorkingRipple"), "Use the shared DotGridSpinner: \(file.lastPathComponent)")
        #expect(!source.contains("DitherRipple"), "Use the shared DotGridSpinner: \(file.lastPathComponent)")
    }
}
