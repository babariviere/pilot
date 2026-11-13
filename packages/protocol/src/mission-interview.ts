/** New-flow host contracts. These records never grant model, tool or delivery permissions. */
export interface InterviewOption {
	id: string;
	meaning: string;
}
export interface InterviewQuestion {
	id: string;
	section: "outcome" | "non-goals" | "constraints" | "acceptance" | "authority";
	prompt: string;
	options: InterviewOption[];
	recommendedOptionId: string | null;
}
export interface InterviewAnswer {
	questionId: string;
	/** Exact question meaning at explicit answer time, not the latest question's digest. */
	questionDigest: string;
	selectedOption: InterviewOption | null;
	/** Custom answer or extra detail. Kept byte-for-byte, including incomplete drafts. */
	text: string;
}
export interface InterviewFence {
	missionId: string;
	ownerSessionId: string;
	enrollmentId: string;
	questionSetRevision: number;
	answerRevision: number;
}
export interface InterviewSubmission {
	/** Revisit answers are evidence only, never a published agreement or approval. */
	kind?: "revisit";
	operationId: string;
	fence: InterviewFence;
	questions: InterviewQuestion[];
	answers: InterviewAnswer[];
	agreementMarkdown: string;
	briefRevision: number;
	digest: string;
}
export interface MissionInterview {
	version: 1;
	/** Absent on historical creation rounds. Once revisiting, later rounds stay inert. */
	kind?: "revisit";
	fence: InterviewFence;
	/** Monotonic saved-state CAS, also fences duplicate submissions and amendments. */
	revision: number;
	ownerFence: { memberEventId: number; coordinatorEventId: number };
	questions: InterviewQuestion[];
	answers: InterviewAnswer[];
	submission: InterviewSubmission | null;
}
export type InterviewVersion = Pick<MissionInterview, "fence" | "revision">;
export type InterviewWrite =
	| { purpose: "interview-questions"; expected: InterviewVersion; questions: InterviewQuestion[]; kind?: "revisit" }
	| { purpose: "interview-save"; expected: InterviewVersion; answers: InterviewAnswer[] }
	| { purpose: "interview-submit"; expected: InterviewVersion };

/** Included verbatim in the immutable workflow approval package for enrolled missions. */
export interface InterviewAgreementBinding {
	enrollmentId: string;
	submission: InterviewSubmission;
	/** Native spec publication approved by this exact submitted review, never a new grant. */
	planning?: { revision: number; digest: string };
}

export interface InterviewContinuation {
	purpose: "interview-continue";
	fence: InterviewFence;
	submissionOperationId: string;
	submissionDigest: string;
}
/** Host-prepared package for one new standalone Build. Not a hidden mission or legacy adoption. */
export interface SmallAskAdmission {
	purpose: "small-ask-start";
	requestId: string;
	projectId: string;
	text: string;
	configurationDigest: string;
}
export interface AgreementAdmission {
	purpose: "agreement-start";
	fence: InterviewFence;
	submissionOperationId: string;
	submissionDigest: string;
	approvalOperationId: string;
	approvalDigest: string;
	/** Exact host-owned assignment/owner/allocation revision identity, never a scope guess. */
	assignmentDigest: string;
}
