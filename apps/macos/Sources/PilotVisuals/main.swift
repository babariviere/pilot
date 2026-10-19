import Foundation
import PilotVisualsHost
import PilotVisualsKit

/// The sandboxed XPC service that runs visual scripts for Pilot. It has no entitlements beyond the App Sandbox: no
/// network and no files. An engine crash ends this process only; launchd relaunches it on Pilot's next request.
final class VisualServiceEndpoint: NSObject, VisualServiceProtocol {
    private let host: VisualHost
    private let lock = NSLock()
    private var region: VisualSharedRegion?

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

    func attach(_ region: VisualSharedRegion) {
        lock.lock()
        defer { lock.unlock() }
        self.region = region
    }

    func draw(_ id: String, canvas: String, width: Double, height: Double, time: Double, pointerX: Double,
              pointerY: Double, hasPointer: Bool, slot: Int, reply: @escaping (Int, Data?) -> Void) {
        lock.lock()
        let region = region
        lock.unlock()
        let target = region.flatMap { region in
            VisualDrawRing.slot(slot, in: region).map { VisualHost.DrawTarget(buffer: $0, owner: region) }
        }
        let request = VisualDrawRequest(canvas: canvas, width: width, height: height, time: time,
                                        pointer: hasPointer ? VisualPoint(x: pointerX, y: pointerY) : nil)
        host.draw(id, request, into: target, reply: reply)
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
