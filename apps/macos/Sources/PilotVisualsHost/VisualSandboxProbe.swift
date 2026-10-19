import Darwin
import Foundation
import PilotVisualEngine
import PilotVisualsKit

/// Checks from inside the service that its sandbox holds: no network and no files outside its container.
/// Packaging smoke tests call it through the probe message.
public enum VisualSandboxProbe {
    public static func run() -> VisualValue {
        let network = networkDenied()
        let files = filesDenied()
        return [
            "engine": .string(String(cString: pv_engine_version())),
            "sandboxed": .bool(network.denied && files.denied),
            "network": .string(network.detail),
            "files": .string(files.detail),
        ]
    }

    /// A loopback connection is refused when nothing listens, but a sandbox without network access denies it.
    private static func networkDenied() -> (denied: Bool, detail: String) {
        let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard socket >= 0 else { return (errno == EPERM || errno == EACCES, describe(errno)) }
        defer { close(socket) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(9).bigEndian
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(socket, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if result == 0 { return (false, "connected") }
        let code = errno
        return (code == EPERM || code == EACCES, describe(code))
    }

    /// The shared temporary directory is outside every container.
    private static func filesDenied() -> (denied: Bool, detail: String) {
        let path = "/private/tmp/pilot-visuals-probe-\(getpid())"
        let descriptor = open(path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        if descriptor >= 0 {
            close(descriptor)
            unlink(path)
            return (false, "created \(path)")
        }
        let code = errno
        return (code == EPERM || code == EACCES, describe(code))
    }

    private static func describe(_ code: Int32) -> String {
        String(cString: strerror(code))
    }
}

