import type { AgentQuestion, AssistanceSubject } from "@pilot/protocol";
import { type AttentionDependencies, AttentionError } from "./attention-service.ts";
import { attentionDigest } from "./attention-store.ts";
import type { MissionStore } from "./missions.ts";

/** Adapter for actual MissionDecisions/proposals, never a second pending-choice store.
 * Native questions require their own exact current-entry reader; transcript history is not enough. */
export function assistanceSource(
	store: MissionStore,
	authorize: (projectId: string, missionId: string) => string,
	question?: AttentionDependencies["subject"],
): AttentionDependencies["subject"] {
	return (subject: AssistanceSubject) => {
		if (subject.kind === "question") {
			if (!question) throw new AttentionError("unavailable", "Current native question reader unavailable");
			return question(subject);
		}
		let value: ReturnType<MissionStore["assistanceSource"]>;
		try {
			value = store.assistanceSource(subject.missionId, subject.kind, subject.id);
		} catch {
			throw new AttentionError("stale", "Mission decision or proposal is no longer current");
		}
		return {
			source: value.source,
			scope: {
				subject,
				projectId: value.projectId,
				eventId: value.eventId,
				contentDigest: attentionDigest(value.source),
				authorityDigest: authorize(value.projectId, subject.missionId),
			},
		};
	};
}

/** Trusted current-boundary reader, not an arbitrary historical transcript entry. Event identity must
 * advance on answer, Stop, replacement and reopen, even if the question bytes are unchanged. */
export interface CurrentAssistanceQuestion {
	projectId: string;
	sessionId: string;
	entryId: number;
	eventId: number;
	questionPending: boolean;
	stopped: boolean;
	question: AgentQuestion;
	authorityDigest: string;
}

export function nativeQuestionAssistance(
	read: (sessionId: string) => CurrentAssistanceQuestion | undefined,
): AttentionDependencies["subject"] {
	return (subject) => {
		if (subject.kind !== "question") throw new AttentionError("invalid", "Expected ordinary question");
		const current = read(subject.sessionId);
		if (
			!current ||
			current.sessionId !== subject.sessionId ||
			current.entryId !== subject.entryId ||
			!current.questionPending ||
			current.stopped ||
			current.question.databaseAccess !== undefined
		)
			throw new AttentionError("stale", "That ordinary question is no longer pending");
		const source = JSON.stringify(current.question);
		return {
			source,
			scope: {
				subject,
				projectId: current.projectId,
				eventId: current.eventId,
				contentDigest: attentionDigest(source),
				authorityDigest: current.authorityDigest,
			},
		};
	};
}
