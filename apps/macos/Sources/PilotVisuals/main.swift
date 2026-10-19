import Foundation
import PilotVisualsHost
import PilotVisualsKit

/// The sandboxed XPC service that runs visual scripts for Pilot. It has no entitlements beyond the App Sandbox: no
/// network and no files. An engine crash ends this process only; launchd relaunches it on Pilot's next request.
final class VisualServiceEndpoint: NSObject, VisualServiceProtocol {
    private let host: VisualHost

    init(host: VisualHost) {
        self.host = host
    }

    func load(_ id: String, runtime: String, source: String, data: Data, state: Data?, seed: String, now: Double,
              reply: @escaping (Data) -> Void) {
        let request = VisualLoadRequest(runtime: runtime, source: source, data: data, state: state, seed: seed, now: now)
        host.load(id, request, reply: reply)
    }

    func event(_ id: String, handler: String, value: Data, reply: @escaping (Data) -> Void) {
        host.event(id, handler: handler, value: value, reply: reply)
    }

    func release(_ id: String) {
        host.release(id)
    }

    func probe(_ reply: @escaping (Data) -> Void) {
        reply(VisualWire.encode(VisualSandboxProbe.run()))
    }
}

final class VisualServiceDelegate: NSObject, NSXPCListenerDelegate {
    private let host = VisualHost()

    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        connection.exportedInterface = NSXPCInterface(with: VisualServiceProtocol.self)
        connection.exportedObject = VisualServiceEndpoint(host: host)
        connection.resume()
        return true
    }
}

let delegate = VisualServiceDelegate()
let listener = NSXPCListener.service()
listener.delegate = delegate
listener.resume()
