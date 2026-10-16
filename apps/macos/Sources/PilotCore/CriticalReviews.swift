// Version 1 critical-review records. Not the /api/reviews result-read marks.
// Host validates tagged values. No review entry points are enabled by these transport models.
import Foundation

public struct ReviewCitation: Codable, Equatable, Sendable {
	public var manifestId: String
	public var blobId: String
	public var start: Int
	public var end: Int
}

public struct ReviewAllowance: Codable, Equatable, Sendable {
	public var moneyMicros: Int
	public var inputTokens: Int
	public var generatedTokens: Int
	public var durationMs: Int
}

public struct CriticalReviewSnapshot: Codable, Equatable, Sendable {
	public var kind: String
	public var sessionId: String?
	public var attemptId: String?
	public var lineageId: String?
	public var treeDigest: String?
	public var repositoryId: String?
	public var head: String?
	public var base: String?
	public var mergeBase: String?
	public var boundary: Int?
	public var number: Int?
}

public struct ReviewEvidenceEntry: Codable, Equatable, Sendable {
	public var blobId: String
	public var sha256: String
	public var bytes: Int
	public var label: String
	public var sourceId: String
	public var category: String
}

public struct ReviewOmission: Codable, Equatable, Sendable {
	public var selectionId: String
	public var reason: String
}

public struct CriticalReviewContextSource: Codable, Equatable, Sendable {
	public var citation: ReviewCitation
	public var basis: String
	public var approvalId: String?
}

public struct CriticalReviewTarget: Codable, Equatable, Sendable {
	public var schemaVersion: Int
	public var id: String
	public var projectId: String
	public var hostId: String
	public var sourceIds: [String]
	public var createdAt: Double
	public var kind: String
	public var snapshot: CriticalReviewSnapshot
}

public struct CriticalReviewEvidence: Codable, Equatable, Sendable {
	public var schemaVersion: Int
	public var id: String
	public var projectId: String
	public var hostId: String
	public var sourceIds: [String]
	public var createdAt: Double
	public var kind: String
	public var sealed: Bool
	public var sha256: String
	public var entries: [ReviewEvidenceEntry]
	public var omissions: [ReviewOmission]
	public var complete: Bool
}

public struct CriticalReviewContext: Codable, Equatable, Sendable {
	public var schemaVersion: Int
	public var id: String
	public var projectId: String
	public var hostId: String
	public var sourceIds: [String]
	public var createdAt: Double
	public var kind: String
	public var policyVersion: String
	public var challenge: String
	public var sources: [CriticalReviewContextSource]
	public var missing: [String]
	public var conflicts: [String]
}

public struct CriticalReviewRun: Codable, Equatable, Sendable {
	public var schemaVersion: Int
	public var id: String
	public var projectId: String
	public var hostId: String
	public var sourceIds: [String]
	public var createdAt: Double
	public var kind: String
	public var targetId: String
	public var evidenceId: String
	public var contextId: String
	public var state: String
	public var effort: String
	public var modelId: String
	public var policyVersion: String
	public var previousRunId: String?
	public var limits: [String]
}

public struct CriticalReviewApproval: Codable, Equatable, Sendable {
	public var schemaVersion: Int
	public var id: String
	public var projectId: String
	public var hostId: String
	public var sourceIds: [String]
	public var createdAt: Double
	public var kind: String
	public var ownerId: String
	public var runId: String
	public var targetId: String
	public var evidenceId: String
	public var action: String
	public var providerId: String
	public var modelId: String
	public var billing: String
	public var allowance: ReviewAllowance
	public var expiresAt: Double
}

public struct CriticalReviewReservation: Codable, Equatable, Sendable {
	public var schemaVersion: Int
	public var id: String
	public var projectId: String
	public var hostId: String
	public var sourceIds: [String]
	public var createdAt: Double
	public var kind: String
	public var runId: String
	public var approvalId: String
	public var callId: String
	public var rateId: String
	public var phase: String
	public var reserved: ReviewAllowance
}

public struct CriticalReviewFinding: Codable, Equatable, Sendable {
	public var schemaVersion: Int
	public var id: String
	public var projectId: String
	public var hostId: String
	public var sourceIds: [String]
	public var createdAt: Double
	public var kind: String
	public var runId: String
	public var severity: String
	public var confidence: String
	public var title: String
	public var trigger: String
	public var expected: String
	public var actual: String
	public var consequence: String
	public var basis: String
	public var verification: String
	public var evidence: [ReviewCitation]
	public var counterevidence: [ReviewCitation]
}

public struct CriticalReviewDisposition: Codable, Equatable, Sendable {
	public var schemaVersion: Int
	public var id: String
	public var projectId: String
	public var hostId: String
	public var sourceIds: [String]
	public var createdAt: Double
	public var kind: String
	public var findingId: String
	public var ownerId: String
	public var value: String
}

