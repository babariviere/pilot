import SwiftUI

/// The conversation owns spare width. A newly opened inspector starts compact, but its native
/// divider can still give a terminal or diff more room without imposing a fixed maximum width.
struct ChatInspectorSplit<Chat: View, Pane: View>: View {
    let showsInspector: Bool
    private let chat: Chat
    private let inspector: Pane

    init(showsInspector: Bool, @ViewBuilder chat: () -> Chat, @ViewBuilder inspector: () -> Pane) {
        self.showsInspector = showsInspector
        self.chat = chat()
        self.inspector = inspector()
    }

    var body: some View {
        HSplitView {
            chat
                .frame(minWidth: 420, maxWidth: .infinity)
                .layoutPriority(1)
            if showsInspector {
                inspector
                    .frame(minWidth: 340, maxWidth: .infinity)
            }
        }
    }
}
