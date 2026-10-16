import PilotCore
import SwiftUI

struct SessionFileViewer: View {
    let session: HostResourceRef
    let path: String
    @ObservedObject var hosts: HostClients
    @State private var content: SessionFileContent?
    @State private var error: String?

    var body: some View {
        SheetScaffold("File", subtitle: path, width: 760) {
            if let error { InlineProblem(error) }
            if let content {
                if content.binary { Text("This file cannot be shown as text.").font(.pilot(.body)) }
                else {
                    ScrollView([.horizontal, .vertical]) {
                        Text(content.text).font(.pilot(.body, design: .monospaced)).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }.frame(height: 420)
                    if content.truncated { Text("Showing the first part of this file.").font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground) }
                }
            } else if error == nil { ProgressView("Loading file…").frame(height: 200) }
        }
        .task(id: session.storageKey + path) {
            do { content = try await hosts.file(session, path: path); error = nil }
            catch { self.error = error.localizedDescription }
        }
    }
}
