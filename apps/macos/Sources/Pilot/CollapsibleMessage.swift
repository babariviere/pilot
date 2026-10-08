import AppKit
import SwiftUI

/// Inspect only a bounded prefix, even for pasted crash reports or streamed megabytes.
struct MessagePreview: Equatable {
    static let characterLimit = 1600
    static let lineLimit = 16
    static let previewCharacterLimit = 800
    static let previewLineLimit = 8
    static let visibleLineLimit = 6
    static let scalarLimit = 6400
    static let previewByteLimit = 3200

    let isLong: Bool
    let text: String

    init(_ source: String) {
        // A Character can contain millions of combining scalars. Bound the probe before
        // grapheme segmentation, and discard its potentially incomplete trailing grapheme.
        var probe = String(String.UnicodeScalarView(source.unicodeScalars.prefix(Self.scalarLimit + 1)))
        let exceededScalarLimit = probe.unicodeScalars.count > Self.scalarLimit
        if exceededScalarLimit { probe.removeLast() }
        var prefix = ""
        var previewBytes = 0
        var previewClosed = false
        var lines = 1
        var characters = 0
        var isLong = exceededScalarLimit
        for character in probe {
            characters += 1
            if character.isNewline { lines += 1 }
            if characters > Self.characterLimit || lines > Self.lineLimit {
                isLong = true
                break
            }
            if characters <= Self.previewCharacterLimit && lines <= Self.previewLineLimit {
                let bytes = character.utf8.count
                if previewBytes + bytes > Self.previewByteLimit { previewClosed = true }
                if !previewClosed {
                    prefix.append(character)
                    previewBytes += bytes
                }
            }
        }
        self.isLong = isLong
        text = isLong ? prefix.trimmingCharacters(in: .whitespacesAndNewlines) : source
    }
}

private struct TranscriptMessageToggledKey: EnvironmentKey {
    static let defaultValue: (() -> Void)? = nil
}

extension EnvironmentValues {
    var transcriptMessageToggled: (() -> Void)? {
        get { self[TranscriptMessageToggledKey.self] }
        set { self[TranscriptMessageToggledKey.self] = newValue }
    }
}

/// The collapsed branch never constructs the full Text/Markdown subtree. A clipped full
/// message would still parse and lay out all of its content inside the lazy transcript.
struct CollapsibleMessage<Content: View>: View {
    let text: String
    let userBubble: Bool
    @ViewBuilder let content: () -> Content
    @StateObject private var expansion: ExpansionState
    @Environment(\.pilotFonts) private var fonts
    @Environment(\.transcriptMessageToggled) private var messageToggled

    init(text: String, userBubble: Bool = false, expansion: ExpansionState? = nil,
         @ViewBuilder content: @escaping () -> Content) {
        self.text = text
        self.userBubble = userBubble
        self.content = content
        _expansion = StateObject(wrappedValue: expansion ?? ExpansionState())
    }

    var body: some View {
        let preview = MessagePreview(text)
        if preview.isLong {
            if expansion.expanded {
                surface {
                    VStack(alignment: .leading, spacing: 8) {
                        content()
                        HStack(spacing: 12) {
                            Button(action: toggle) {
                                Label("Show less", systemImage: "chevron.up").font(.caption)
                            }
                            .buttonStyle(.plain)
                            Button(action: copy) {
                                Image(systemName: "doc.on.doc").font(.caption)
                            }
                            .buttonStyle(.plain)
                            .help("Copy full message")
                        }
                        .foregroundStyle(.secondary)
                    }
                }
            } else {
                Button(action: toggle) {
                    VStack(spacing: 8) {
                        surface(folded: true) {
                            Text(preview.text.isEmpty ? "Long message" : preview.text)
                                .font(fonts.body)
                                .lineSpacing(5)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(height: previewHeight, alignment: .top)
                                .clipped()
                                .mask(LinearGradient(stops: [
                                    .init(color: .black, location: 0),
                                    .init(color: .black, location: 0.63),
                                    .init(color: .clear, location: 1),
                                ], startPoint: .top, endPoint: .bottom))
                        }
                        Image(systemName: "chevron.down")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Expand message")
                .accessibilityHint("Shows the full message")
                .help("Click to show the full message")
                .contextMenu { Button("Copy full message", action: copy) }
            }
        } else {
            surface { content() }
        }
    }

    /// Native font metrics keep the cutoff near six lines as chat size/family changes,
    /// without observing transcript geometry or laying out the full message.
    private var previewHeight: CGFloat {
        let font = fonts.nsBody
        return ceil(font.ascender - font.descender + font.leading + 5) * CGFloat(MessagePreview.visibleLineLimit)
    }

    @ViewBuilder private func surface<Body: View>(folded: Bool = false, @ViewBuilder body: () -> Body) -> some View {
        if userBubble {
            body()
                .padding(.horizontal, 14)
                .padding(.top, 10)
                .padding(.bottom, folded ? 4 : 10)
                .background {
                    RoundedRectangle(cornerRadius: 12).fill(Theme.muted)
                        .background {
                            if folded {
                                // Theme.muted is translucent: cast the shadow from an opaque
                                // backing so it remains visible without darkening the bubble.
                                RoundedRectangle(cornerRadius: 12).fill(Theme.background)
                                    .shadow(color: .black.opacity(0.065), radius: 8, x: 0, y: 6)
                            }
                        }
                }
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.border))
        } else {
            body()
                .background(alignment: .bottom) {
                    if folded {
                        Rectangle().fill(Theme.background).frame(height: 1)
                            .shadow(color: .black.opacity(0.065), radius: 8, x: 0, y: 6)
                    }
                }
        }
    }

    private func copy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    private func toggle() {
        // Reading an expanded message must not trigger Markdown's asynchronous bottom-follow.
        messageToggled?()
        expansion.expanded.toggle()
    }
}
