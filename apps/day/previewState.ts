// Preview-only draft text. NSH scopes Storage to the separate preview app id.
// This is not a production durable receipt, command journal or live profile.
import { effect, Storage, signal, untracked } from "nsh";
import type { Day } from "./day";
import { restoreAnswerDraft } from "./planCommands";
import type { Plans } from "./planning";
import { answerDrafts, answerPicks, goalDraft } from "./planView";
import { drafts, replies, reports } from "./view";

const KEY = "preview-drafts-v1";
export const previewSaveError = signal("");
export const previewReady = signal(false);

type Texts = Record<string, string>;
type Answer = { text: string; choice: string | null };
type Kept = {
	version: 1;
	goal: string;
	questions: Texts;
	replies: Texts;
	reports: Texts;
	answers: Record<string, Answer>;
};

function texts(value: unknown): value is Texts {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.values(value).every((entry) => typeof entry === "string")
	);
}

/** Invalid or newer formats are left untouched, not overwritten with empty text. */
export function parsePreviewDrafts(raw: string): Kept {
	const value = JSON.parse(raw) as Kept;
	if (
		value?.version !== 1 ||
		typeof value.goal !== "string" ||
		![value.questions, value.replies, value.reports].every(texts) ||
		!value.answers ||
		Array.isArray(value.answers) ||
		typeof value.answers !== "object" ||
		Object.values(value.answers).some(
			(a) => !a || typeof a.text !== "string" || (a.choice !== null && typeof a.choice !== "string"),
		)
	) {
		throw new Error("Unsupported preview drafts");
	}
	return value;
}

/** Save text only. Reopening never replays demo actions, submissions or provider effects. */
export function keepPreviewDrafts(day: Day, plans: Plans) {
	const loaded = signal(false);
	let keptAnswers: Record<string, Answer> = {};
	const seen = new Set<string>();
	void (async () => {
		try {
			const raw = await Storage.getItem(KEY);
			if (raw) {
				const saved = parsePreviewDrafts(raw);
				goalDraft.set(saved.goal);
				drafts.set(saved.questions);
				replies.set(saved.replies);
				reports.set(saved.reports);
				keptAnswers = saved.answers;
			}
			loaded.set(true);
		} catch {
			previewSaveError.set(
				"Preview drafts could not be read. The saved copy is unchanged. Keep this window open to keep new text.",
			);
		} finally {
			previewReady.set(true);
		}
	})();
	effect(() => {
		if (!loaded()) return;
		// A mock save removes a draft from the screen store. Keep its exact
		// text as well, without restoring a submitted/answered state.
		for (const row of plans.planning().plans) {
			const interview = plans.feed.page(row.missionId)?.interview;
			if (!interview) continue;
			for (const question of interview.questions) {
				const key = `${interview.id}/${question.id}/${question.digest}`;
				if (!seen.has(key)) {
					seen.add(key);
					const saved = keptAnswers[key];
					if (saved && interview.submit === "open")
						untracked(() => restoreAnswerDraft(row.missionId, interview, question, saved.text, saved.choice));
				}
				const short = `${interview.id}/${question.id}`;
				const text = answerDrafts()[short] ?? question.text;
				const choice = short in answerPicks() ? answerPicks()[short] : (question.chosen ?? null);
				keptAnswers[key] = { text, choice: choice ?? null };
			}
		}
		const today = day.today();
		const questions = Object.fromEntries(today.decisions.map((d) => [d.id, d.draft.question]));
		const ownWords = Object.fromEntries(today.decisions.map((d) => [d.id, d.draft.text]));
		const notes = Object.fromEntries(today.actions.map((a) => [a.id, a.draft.text]));
		const saved: Kept = {
			version: 1,
			goal: goalDraft(),
			questions: { ...questions, ...drafts() },
			replies: { ...ownWords, ...replies() },
			reports: { ...notes, ...reports() },
			answers: keptAnswers,
		};
		untracked(
			() =>
				void Storage.setItem(KEY, JSON.stringify(saved)).catch(() => {
					previewSaveError.set("Preview drafts could not be saved. Keep this window open to keep your text.");
				}),
		);
	});
}
