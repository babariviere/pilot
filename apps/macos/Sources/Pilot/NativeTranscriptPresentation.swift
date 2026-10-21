import AppKit
import PilotCore
import SwiftUI

/// Expanded viewers remain app-shell sheets. A recycled row holds no sheet lifetime or responder.
@MainActor
final class NativeTranscriptPresentation: ObservableObject {
    struct Request: Identifiable {
        enum Content {
            case diagram(MarkdownDiagramKind, String, NativeMermaidLayout?)
            case artifact(ArtifactReference)
            case schedule(ScheduledItem)
        }
        let id = UUID()
        let content: Content
        let environment: EnvironmentValues
    }
    @Published var request: Request?
}

private struct NativeTranscriptPresentationKey: EnvironmentKey {
    static let defaultValue: ((NativeTranscriptPresentation.Request) -> Void)? = nil
}

private struct NativeTranscriptMenuKey: EnvironmentKey {
    static let defaultValue: ((NSMenu) -> Void)? = nil
}

extension EnvironmentValues {
    var nativeTranscriptMenu: ((NSMenu) -> Void)? {
        get { self[NativeTranscriptMenuKey.self] }
        set { self[NativeTranscriptMenuKey.self] = newValue }
    }
    var nativeTranscriptPresent: ((NativeTranscriptPresentation.Request) -> Void)? {
        get { self[NativeTranscriptPresentationKey.self] }
        set { self[NativeTranscriptPresentationKey.self] = newValue }
    }
}

struct NativeTranscriptPresentedContent: View {
    let request: NativeTranscriptPresentation.Request

    var body: some View {
        // Forward row ownership and actions, not the presenting chat's entire environment.
        // In particular, dismiss/isPresented must belong to the new SwiftUI sheet.
        content
            .environment(\.hostViewContext, request.environment.hostViewContext)
            .environment(\.transcriptComposer, request.environment.transcriptComposer)
            .environment(\.pilotFonts, request.environment.pilotFonts)
            .environment(\.openURL, request.environment.openURL)
    }

    @ViewBuilder private var content: some View {
        switch request.content {
        case let .diagram(kind, source, native):
            if let native {
                NativeDiagramViewer(kind: kind, text: source, layout: native)
            } else {
                InlineDiagramViewer(kind: kind, text: source)
            }
        case let .artifact(reference):
            ArtifactViewer(reference: reference, latest: false)
        case let .schedule(item):
            EditScheduleSheet(item: item)
        }
    }
}
