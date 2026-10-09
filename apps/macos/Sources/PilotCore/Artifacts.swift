import Foundation

public enum ArtifactKind: String, Codable, Hashable, Sendable {
    case html, react, image, swiftui

    public var sourceLanguage: String {
        switch self {
        case .html, .image: return "html"
        case .react: return "jsx"
        case .swiftui: return "swift"
        }
    }
}

public enum ArtifactLibrary: String, Codable, CaseIterable, Hashable, Sendable {
    case react, mermaid, echarts, motion, d3, three
    case reactDOM = "react-dom"
}

public struct ArtifactSummary: Codable, Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let sessionId: String
    public let projectId: String?
    public let title: String
    public let kind: ArtifactKind
    public let revision: Int
    public let createdAt: Double
    public let updatedAt: Double

    public var reference: ArtifactReference {
        ArtifactReference(id: id, sessionId: sessionId, title: title, revision: revision)
    }
}

/// GET /api/sessions/:sid/artifacts/:id. No revision query means latest.
public struct ArtifactRevision: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let sessionId: String
    public let projectId: String?
    public let title: String
    public let kind: ArtifactKind
    public let revision: Int
    public let createdAt: Double
    public let updatedAt: Double
    public let source: String
    public let html: String
    public let libraries: [ArtifactLibrary]
    /// Library versions used when the revision was prepared. Absent on older revisions.
    public var libraryVersions: [String: String]? = nil
}

public struct ArtifactReference: Codable, Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let sessionId: String
    public let title: String
    public let revision: Int

    public init(id: String, sessionId: String, title: String, revision: Int) {
        self.id = id
        self.sessionId = sessionId
        self.title = title
        self.revision = revision
    }

    /// Only structured tool metadata, never text or arguments, supplies a reference.
    public static func fromToolResult(_ json: JSONValue) -> ArtifactReference? {
        let wrapped = json["details"]?["__piNativeAdapter"]
        let candidates = [json["details"]?["artifact"], json["structuredContent"]?["artifact"],
                          wrapped?["details"]?["artifact"], wrapped?["structuredContent"]?["artifact"]]
        for candidate in candidates {
            if let value = candidate, let reference = try? value.decode(ArtifactReference.self),
               !reference.id.isEmpty, !reference.sessionId.isEmpty, reference.revision > 0 {
                return reference
            }
        }
        return nil
    }
}

/// WS replacement list scoped to one session, including an empty list.
public struct ArtifactListMessage: Codable, Equatable, Sendable {
    public let type: String
    public let sessionId: String
    public let artifacts: [ArtifactSummary]

    public static func parse(_ json: JSONValue) -> ArtifactListMessage? {
        guard json["type"]?.string == "artifacts",
              let message = try? json.decode(Self.self),
              message.artifacts.allSatisfy({ $0.sessionId == message.sessionId }) else { return nil }
        return message
    }
}

/// The native scheme handler and WebKit request blocker share this strict allowlist.
public enum ArtifactSandboxPolicy {
    /// WebRTC UDP and WebTransport can bypass request interception/content blockers.
    /// Installed in the page world at document start in every frame, before HTML JS.
    public static let networkGuard = """
    (() => {
      for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'WebTransport']) {
        Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false });
      }
    })();
    """
    public static func library(for url: URL) -> ArtifactLibrary? {
        guard url.scheme == "pilot-artifact", url.host == "library", url.port == nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              let library = ArtifactLibrary(rawValue: String(url.path.dropFirst())),
              url.absoluteString == "pilot-artifact://library/\(library.rawValue)" else { return nil }
        return library
    }

    /// Deny network resource loads. Exact library script URLs and in-memory images,
    /// fonts/media have narrow exceptions. CSP independently forbids data/blob scripts.
    public static let contentRules: String = {
        // WebKit's restricted regex dialect does not support alternation. Keep each
        // canonical library in its own anchored rule, rather than a grouped regex.
        var rules = [#"{"trigger":{"url-filter":".*"},"action":{"type":"block"}}"#]
        for library in ArtifactLibrary.allCases {
            rules.append("""
            {"trigger":{"url-filter":"^pilot-artifact://library/\(library.rawValue)$","resource-type":["script"]},"action":{"type":"ignore-previous-rules"}}
            """)
        }
        rules.append(#"{"trigger":{"url-filter":"^data:","resource-type":["image","font","media"]},"action":{"type":"ignore-previous-rules"}}"#)
        rules.append(#"{"trigger":{"url-filter":"^blob:","resource-type":["image","media"]},"action":{"type":"ignore-previous-rules"}}"#)
        return "[" + rules.joined(separator: ",") + "]"
    }()

    /// Prepend our own policy before any untrusted markup. Additional backend CSPs
    /// intersect with this one and cannot loosen it. No eval, frames, workers, forms,
    /// network connections, objects or base-URL overrides.
    public static func document(_ html: String) -> String {
        """
        <!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' pilot-artifact:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
        <meta http-equiv="x-dns-prefetch-control" content="off">
        \(html)
        """
    }
}
