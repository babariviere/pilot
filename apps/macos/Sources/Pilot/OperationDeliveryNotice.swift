import PilotCore
import SwiftUI

/// Recovery is visible and user-driven. Reconnect reads receipts, never sends another message.
struct OperationDeliveryNotice: View {
    let ref: HostResourceRef
    @ObservedObject var hosts: HostClients
    let adopt: (DurableOperation) async throws -> Void
    var excludes: (DurableOperation) -> Bool = { _ in false }
    @State private var busy = false
    @State private var error: String?
    @State private var confirmingRetry: DurableOperation?

    private var operations: [DurableOperation] {
        hosts.pendingOperations.values.filter {
            $0.destination == ref.host && $0.targetId == ref.localId &&
            ($0.kind == "chat-send" || $0.kind == "chat-send-attached") && !excludes($0)
        }.sorted { $0.sequence < $1.sequence }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(operations.prefix(4)), id: \.operationId) { operation in
                HStack {
                    Text(label(operation)).font(.pilot(.caption)).foregroundStyle(Theme.mutedForeground)
                    Spacer(minLength: 8)
                    if case let .receipt(receipt)? = hosts.operationDeliveries[operation.operationId], receipt.state != .pending {
                        Button("Save result") { run { try await adopt(operation) } }
                    } else {
                        Button("Check delivery") { run { try await hosts.reconcileOperations(ref.host) } }
                        if case .unknown? = hosts.operationDeliveries[operation.operationId] {
                            Button("Retry original message…") { confirmingRetry = operation }
                        }
                    }
                }.disabled(busy || !hosts.available.contains(ref.host))
            }
            if operations.count > 4 { Text("More messages are awaiting confirmation.").font(.pilot(.caption)) }
            if let error { InlineProblem(error) }
        }
        .frame(maxWidth: Theme.column)
        .confirmationDialog("Retry the original message?", isPresented: Binding(get: { confirmingRetry != nil }, set: {
            if !$0 { confirmingRetry = nil }
        }), presenting: confirmingRetry) { operation in
            Button("Retry original message") { run { try await hosts.retryOperation(operation) } }
        } message: { _ in
            Text("Pilot checks first, then retries only the same message on the same devbox. Changes in your current draft are not sent.")
        }
    }

    private func label(_ operation: DurableOperation) -> String {
        guard case let .receipt(receipt)? = hosts.operationDeliveries[operation.operationId] else { return "Delivery unknown. Your draft has been kept." }
        switch receipt.state {
        case .pending: return "Message accepted for checking. Delivery is not yet confirmed."
        case .accepted: return "Message delivered. Save the result to finish updating your draft."
        case .rejected: return "Message not sent. Your draft has been kept."
        }
    }

    private func run(_ action: @escaping () async throws -> Void) {
        busy = true
        Task {
            defer { busy = false }
            do { try await action(); error = nil } catch { self.error = error.localizedDescription }
        }
    }
}
