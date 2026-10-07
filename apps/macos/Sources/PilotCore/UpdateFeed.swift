import Foundation

/// Sparkle 2.8 replaces Accept with application/rss+xml when fetching an appcast.
/// GitHub needs application/octet-stream to redirect a private asset to its signed CDN URL.
/// Resolve that redirect ourselves, without sending the GitHub token to the CDN.
public enum UpdateFeed {
    public static func resolve(repository: UpdateRepository, assetURL: URL, token: String,
                               session: URLSession = .shared) async throws -> URL {
        guard repository.permitsAssetURL(assetURL) else {
            throw failure("The update feed is not a GitHub asset in the configured repository.")
        }
        var request = URLRequest(url: assetURL)
        request.timeoutInterval = 30
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
        request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        let (_, response) = try await session.data(for: request, delegate: UpdateFeedRedirectDelegate())
        guard let response = response as? HTTPURLResponse else {
            throw failure("GitHub returned an invalid update feed response.")
        }
        guard [301, 302, 303, 307, 308].contains(response.statusCode),
              let location = response.value(forHTTPHeaderField: "Location"),
              let url = URL(string: location), permitsDownloadURL(url) else {
            throw failure("GitHub did not return a signed update feed download (HTTP \(response.statusCode)).",
                          httpStatus: response.statusCode)
        }
        return url
    }

    private static func permitsDownloadURL(_ url: URL) -> Bool {
        url.scheme == "https" && url.host == "release-assets.githubusercontent.com" &&
            url.port == nil && url.user == nil && url.password == nil && url.fragment == nil &&
            !url.path.isEmpty && url.path != "/"
    }

    private static func failure(_ message: String, httpStatus: Int? = nil) -> NSError {
        var info: [String: Any] = [NSLocalizedDescriptionKey: message]
        if let httpStatus { info["GitHubHTTPStatus"] = httpStatus }
        return NSError(domain: "PilotUpdates", code: 3, userInfo: info)
    }
}

private final class UpdateFeedRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
