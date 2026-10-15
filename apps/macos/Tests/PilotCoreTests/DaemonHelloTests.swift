import Foundation
import Testing
@testable import PilotCore

@Test func daemonHelloDecodesAndNegotiatesProtocolIndependentlyOfRelease() throws {
    let data = Data("""
    {"daemonId":"f054881d-9cb8-465f-b99f-37668fbe2541","daemonVersion":"1.37.0",
     "protocolVersion":1,"minimumClientProtocolVersion":1,"platform":"linux","arch":"x64",
     "capabilities":{"powerManagement":false,"systemSleepEvents":false,"swiftUIArtifacts":false,
                     "coordinatorIsolation":false,"independentExecution":true}}
    """.utf8)
    let hello = try JSONDecoder().decode(DaemonHello.self, from: data)
    #expect(hello.isProtocolCompatible)
    #expect(!hello.capabilities.powerManagement)
    #expect(!hello.capabilities.coordinatorIsolation)
    #expect(hello.capabilities.independentExecution)
    let future = Data(String(decoding: data, as: UTF8.self)
        .replacingOccurrences(of: "\"minimumClientProtocolVersion\":1", with: "\"minimumClientProtocolVersion\":2")
        .utf8)
    #expect(!(try JSONDecoder().decode(DaemonHello.self, from: future)).isProtocolCompatible)
    let malformed = Data(String(decoding: data, as: UTF8.self)
        .replacingOccurrences(of: "\"minimumClientProtocolVersion\":1", with: "\"minimumClientProtocolVersion\":0")
        .utf8)
    #expect(!(try JSONDecoder().decode(DaemonHello.self, from: malformed)).isProtocolCompatible)
}
