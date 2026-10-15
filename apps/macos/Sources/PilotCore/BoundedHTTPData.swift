import Foundation

/// Per-request delegate enforces response limits while receiving, not after unbounded buffering.
/// Redirects never leave the endpoint. No cookies or credential persistence.
public enum BoundedHTTPData {
    public static func read(_ request: URLRequest, maximumBytes: Int,
                            configuration: URLSessionConfiguration = .ephemeral,
                            uploadFile: URL? = nil) async throws -> (Data, HTTPURLResponse) {
        let reader = Reader(request: request, maximumBytes: maximumBytes, configuration: configuration, uploadFile: uploadFile)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { reader.start($0) }
        } onCancel: { reader.cancel() }
    }

    private final class Reader: NSObject, URLSessionDataDelegate, @unchecked Sendable {
        let request: URLRequest
        let maximumBytes: Int
        let configuration: URLSessionConfiguration
        let uploadFile: URL?
        let lock = NSLock()
        var session: URLSession?
        var continuation: CheckedContinuation<(Data, HTTPURLResponse), Error>?
        var response: HTTPURLResponse?
        var data = Data()
        var cancelled = false

        init(request: URLRequest, maximumBytes: Int, configuration: URLSessionConfiguration, uploadFile: URL?) {
            self.request = request; self.maximumBytes = maximumBytes
            self.configuration = configuration
            self.uploadFile = uploadFile
        }
        func start(_ continuation: CheckedContinuation<(Data, HTTPURLResponse), Error>) {
            lock.lock()
            if cancelled { lock.unlock(); continuation.resume(throwing: CancellationError()); return }
            self.continuation = continuation
            let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
            self.session = session
            let task: URLSessionTask
            if let uploadFile { task = session.uploadTask(with: request, fromFile: uploadFile) }
            else { task = session.dataTask(with: request) }
            lock.unlock()
            task.resume()
        }
        func cancel() {
            lock.lock(); cancelled = true; lock.unlock()
            finish(.failure(CancellationError()))
        }
        func finish(_ result: Result<(Data, HTTPURLResponse), Error>) {
            lock.lock()
            let continuation = continuation
            self.continuation = nil
            let session = session
            self.session = nil
            data = Data()
            lock.unlock()
            session?.invalidateAndCancel()
            continuation?.resume(with: result)
        }
        func urlSession(_ session: URLSession, task: URLSessionTask,
                        willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                        completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
            guard let http = response as? HTTPURLResponse, http.url == request.url,
                  response.expectedContentLength <= maximumBytes else {
                completionHandler(.cancel)
                finish(.failure(HostRoutingError.invalidReference)); return
            }
            lock.lock(); self.response = http; lock.unlock()
            completionHandler(.allow)
        }
        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive bytes: Data) {
            lock.lock()
            guard continuation != nil else { lock.unlock(); return }
            let fits = bytes.count <= maximumBytes - data.count
            if fits { data.append(bytes) }
            lock.unlock()
            if !fits { finish(.failure(CocoaError(.fileReadTooLarge))) }
        }
        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            lock.lock()
            let response = response; let data = data
            lock.unlock()
            if let error { finish(.failure(error)) }
            else if let response { finish(.success((data, response))) }
            else { finish(.failure(HostRoutingError.disconnected)) }
        }
    }
}
