import { expect, test } from "nsh/test";
import { atQuestion } from "./interviewView";
import { captureView, restoreView } from "./windowState";

test("saved view restores scoped standalone question and review navigation", () => {
	const before = captureView();
	try {
		const interview = "attention/question-chat-123/round-456";
		for (const question of ["authority", "\u0000answers"]) {
			atQuestion.set({ [interview]: question, "mission-round": "acceptance" });
			const saved = captureView();
			atQuestion.set({});
			restoreView(saved);
			expect(atQuestion()).toEqual({ [interview]: question, "mission-round": "acceptance" });
		}
	} finally {
		restoreView(before);
	}
});
