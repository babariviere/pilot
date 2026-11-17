import { expect, test } from "nsh/test";
import { atQuestion, deferredQuestions } from "./interviewView";
import { goalDraft, replacesDraft } from "./planView";
import { captureView, restoreView } from "./windowState";

test("saved view restores scoped standalone question and review navigation", () => {
	const before = captureView();
	try {
		const interview = "attention/question-chat-123/round-456";
		for (const question of ["authority", "\u0000answers"]) {
			atQuestion.set({ [interview]: question, "mission-round": "acceptance" });
			deferredQuestions.set({ [`${interview}/authority`]: "exact-digest" });
			goalDraft.set("Keep this replacement draft");
			replacesDraft.set({ missionId: "old-mission", title: "Original work" });
			const saved = captureView();
			atQuestion.set({});
			deferredQuestions.set({});
			restoreView(saved);
			expect(atQuestion()).toEqual({ [interview]: question, "mission-round": "acceptance" });
			expect(deferredQuestions()).toEqual({ [`${interview}/authority`]: "exact-digest" });
			expect(replacesDraft()).toEqual({ missionId: "old-mission", title: "Original work" });
		}
	} finally {
		restoreView(before);
	}
});
