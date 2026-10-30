/** Local read-only retained comparisons. No capture, review or acceptance mutations. */
export interface NativeReviewWorker {
	id: string;
	title: string;
}
export interface NativeReviewComparison {
	snapshotId: string;
	sequence: number;
	capturedAt: number;
	request: {
		requestId: string;
		repositoryId: string;
		changeId: string;
		operationId: string;
		base: { changeId: string; commitId: string };
		head: { changeId: string; commitId: string };
		scope: { kind: "layer" | "stack" };
		source: "committed" | "working-copy";
	};
	status: "complete" | "partial" | "unavailable";
}
export interface NativeReviewCaptureStatus {
	pending: number;
	failed: number;
	unavailable?: "not-enabled" | "observation-failed";
	unsupported?: (
		| "divergent"
		| "multiple-parents"
		| "root-base"
		| "missing"
		| "unknown-custody"
		| "unknown-discovery"
		| "conflicted"
	)[];
}
export interface NativeReviewSource {
	path: string;
	mode: string;
	gitOid: string;
	state: "text" | "binary" | "unavailable";
	sha256: string | null;
	bytes: number | null;
	reason?: string;
}
export interface NativeReviewSnapshot {
	snapshotId: string;
	request: NativeReviewComparison["request"];
	workerId: string;
	status: NativeReviewComparison["status"];
	capturedAt: number;
	/** Enrollment scope is not historical task purpose. */
	enrollmentTaskIds: string[];
	creation: { changeId: string; commitId: string; operationId: string; kind: string };
	omissions: string[];
	before: NativeReviewSource[];
	after: NativeReviewSource[];
	changes: {
		status: string;
		beforePath: string | null;
		afterPath: string | null;
		beforeMode: string;
		afterMode: string;
		beforeOid: string;
		afterOid: string;
	}[];
	diff: { sha256: string; bytes: number } | null;
}
export interface NativeReviewAssessment {
	id: string;
	taskId: string;
	profile: string;
	profileRevision: number;
	intent: string;
	applicability: "outdated" | "unavailable";
	state: string;
	outcome: string | null;
	reason: string;
	limitations: string;
	/** Recorded agent claims, never observed checks, independence or acceptance. */
	findings: {
		title: string;
		trigger: string;
		cost: string;
		severity: string;
		evidence: { path: string; side: "before" | "after"; sha256: string; start: number; end: number }[];
	}[];
}
export interface NativeReviewRecords {
	assessments: NativeReviewAssessment[];
	reported: { id: string; taskId: string; intent: string; claim: string; limitations: string }[];
	allocations: { id: string; taskId: string; intent: string; reason: string }[];
	more: boolean;
}
