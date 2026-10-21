import SwiftUI

private struct SharedMemoryReadOnlyKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    var sharedMemoryReadOnly: Bool {
        get { self[SharedMemoryReadOnlyKey.self] }
        set { self[SharedMemoryReadOnlyKey.self] = newValue }
    }
}
