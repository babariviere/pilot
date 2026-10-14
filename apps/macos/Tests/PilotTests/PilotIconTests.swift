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
            #expect([PilotIcon.working, .branch, .pullRequest].contains(icon))
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

@Test func vocabularyFillExceptionsAreExplicitAndBounded() {
    let stateful: Set<PilotIcon> = [.home, .inbox, .overview, .pin, .complete, .warning, .question, .memoryEntry]
    #expect(Set(PilotIcon.allCases.filter { $0.stateFillName != nil }) == stateful)
    let alwaysFilled = Set(PilotIcon.allCases.filter {
        ($0.systemName?.contains(".fill") ?? false) || ($0.systemName?.contains("filled") ?? false)
    })
    #expect(alwaysFilled == PilotIcon.alwaysFilledIcons)
    #expect(stateful.isDisjoint(with: alwaysFilled))
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

@Test @MainActor func workingRippleFramesAreBoundedHardPixelsAndActuallyChange() throws {
    let frames = try (0..<DitherCorner.frameCount).map {
        try #require(DitherRippleRenderer.image(frame: $0, background: false, compact: true))
    }
    #expect(frames.count == DitherCorner.frameCount)
    var patterns = Set<Data>()
    for frame in frames {
        #expect(frame.width == 8 && frame.height == 8)
        #expect(!frame.shouldInterpolate)
        let data = try #require(frame.dataProvider?.data) as Data
        #expect(data.count == 8 * 8 * 4)
        let alpha = stride(from: 3, to: data.count, by: 4).map { data[$0] }
        #expect(Set(alpha) == [0, UInt8(0.85 * 255)], "One flat working opacity, no blurred edges")
        patterns.insert(data)
    }
    #expect(patterns.count >= 12)
    #expect(DitherRippleRenderer.image(frame: DitherCorner.frameCount, background: false, compact: true) === frames[0])
    #expect(DitherRippleRenderer.cachedCount <= 2 * (DitherCorner.frameCount + DitherCorner.backgroundFrameCount))
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
        #expect(!source.contains("WorkingRipple"), "Use the shared DitherRipple: \(file.lastPathComponent)")
    }
}
