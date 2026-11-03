// SwiftUI artifact source. Static mock data, not the real application views.
struct ArtifactView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Workspace shell").font(.system(size: 21, weight: .semibold))
            pane(host: "lab-box", disconnected: false)
            pane(host: "lab-box", disconnected: true)
            Text("Static mock, not the live views. Disconnect does not stop the remote shell or agent.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
        }
        .padding(24).frame(width: 740)
        .background(Color(nsColor: .windowBackgroundColor))
    }
    private func pane(host: String, disconnected: Bool) -> some View {
        VStack(spacing: 0) {
            HStack {
                Text("Shell").font(.system(size: 13, weight: .semibold))
                Text("\(host) · /home/alex/projects/pilot/workspace")
                    .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                Image(systemName: "ellipsis").foregroundStyle(.secondary)
            }.padding(12)
            Divider()
            if disconnected {
                HStack {
                    Text("Disconnected. The shell may still be running on lab-box.")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                    Spacer()
                    Text("Reconnect").font(.system(size: 12, weight: .medium))
                }.padding(12)
            }
            VStack(alignment: .leading, spacing: 7) {
                Text("alex@lab-box workspace % pwd")
                Text("/home/alex/projects/pilot/workspace")
                Text("alex@lab-box workspace % ")
            }
            .font(.system(size: 12, design: .monospaced))
            .foregroundStyle(disconnected ? Color.secondary : Color.primary)
            .frame(maxWidth: .infinity, minHeight: 104, alignment: .topLeading).padding(12)
            .background(disconnected ? Color.gray.opacity(0.04) : Color.white)
        }
        .overlay(Rectangle().stroke(Color.gray.opacity(0.2), lineWidth: 1))
    }
}
