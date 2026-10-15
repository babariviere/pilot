import Foundation
import Testing
@testable import PilotCore

private final class BoundedFixtureProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "bounded.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        let headers = path == "/length" ? ["Content-Length": "1024"] : [:]
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                       headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if path == "/good" { client?.urlProtocol(self, didLoad: Data("ok".utf8)) }
        else {
            for _ in 0..<4 { client?.urlProtocol(self, didLoad: Data(repeating: 1, count: 8)) }
        }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@Test func httpReadersBoundAnnouncedAndChunkedBodiesWithoutARealServer() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [BoundedFixtureProtocol.self]
    let good = try await BoundedHTTPData.read(URLRequest(url: URL(string: "https://bounded.invalid/good")!),
                                             maximumBytes: 16, configuration: configuration)
    #expect(good.0 == Data("ok".utf8))
    for path in ["length", "chunks"] {
        do {
            _ = try await BoundedHTTPData.read(URLRequest(url: URL(string: "https://bounded.invalid/\(path)")!),
                                              maximumBytes: 16, configuration: configuration)
            Issue.record("Oversized response must fail")
        } catch {}
    }
}

@Test func preparedUploadsStayInsideOwnedAttachmentStorage() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appendingPathComponent("image.png")
    try Data("normalized bytes".utf8).write(to: file)
    let origin = HostRef(hostId: "local", daemonId: "daemon", lineageId: "history")
    let prepared = try await AttachmentTransfer.prepare(file: file, ownedDirectory: directory,
                                                        uploadId: UUID().uuidString, origin: origin)
    #expect(prepared.bytes == 16)
    #expect(prepared.sha256.count == 64)
    let link = directory.appendingPathComponent("outside")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: URL(filePath: "/etc/hosts"))
    do {
        _ = try await AttachmentTransfer.prepare(file: link, ownedDirectory: directory,
                                                 uploadId: UUID().uuidString, origin: origin)
        Issue.record("Outside symlink must fail")
    } catch { #expect(error as? HostRoutingError == .invalidReference) }
}

