// Mock data only. No account, daemon or real continuation.
import { mount, Scroll, signal, Text, View } from "nsh";
import type { Decision, DraftIntent, ReplyIntent } from "pilot-day/native";
import { DecisionCard } from "./DecisionCard";
import { openDay } from "./mockFeeds";
import { Action } from "./ui";

const day = openDay();
const base = day.today().decisions[0]!;
const question = (id: string, section: string, prompt: string, options: { id: string; meaning: string }[]) => ({
	id,
	section,
	prompt,
	options,
	context: "Your answers stay as drafts until you submit the full round.",
	recommendedOptionId: options[0]?.id ?? null,
	selectedOptionId: null,
	text: "",
});
const original: Decision = {
	...base,
	id: "mock-round",
	revision: 1,
	title: "Questions before proceeding",
	reply: true,
	options: [],
	interviewRoundId: "round-1",
	interviewQuestions: [
		question("outcome", "outcome", "What should change for people using Pilot?", [
			{ id: "drafts", meaning: "Keep answers when the window closes" },
			{ id: "fast", meaning: "Make review faster" },
		]),
		question("authority", "authority", "Who can approve the final changes?", []),
	],
	draft: { ...base.draft, pick: null, picks: [], text: "", question: "", later: false },
	delivery: "idle",
};
const decision = signal(original);
const visible = signal(true);
const saved = signal("");
const saves = signal(0);
const sends = signal(0);
const checks = signal(0);
day.feed = Object.assign(Object.create(Object.getPrototypeOf(day.feed)), day.feed, {
	saveDraft(intent: DraftIntent) {
		saved.set(intent.text);
		saves.set(saves() + 1);
		return { status: "accepted", message: "", revision: 1 };
	},
	flushDrafts() {},
	async reply(_intent: ReplyIntent) {
		sends.set(sends() + 1);
		decision.set({ ...decision(), delivery: "unknown" });
		return { status: "unknown", message: "Not confirmed. Check again reads only.", revision: 1 };
	},
	async check() {
		checks.set(checks() + 1);
		return { status: "unknown", message: "Still not confirmed.", revision: 1 };
	},
});

// The fixture simulates native draft projection on reopening. Runtime TSX never parses JSON.
function reopen() {
	const draft = saved()
		? (JSON.parse(saved()) as { answers: { questionId: string; selectedOptionId: string | null; text: string }[] })
		: { answers: [] };
	decision.set({
		...decision(),
		draft: { ...decision().draft, text: saved() },
		interviewQuestions: decision().interviewQuestions.map((q) => {
			const a = draft.answers.find((a) => a.questionId === q.id);
			return { ...q, selectedOptionId: a?.selectedOptionId ?? null, text: a?.text ?? "" };
		}),
	});
	visible.set(true);
}

mount(() => (
	<Scroll testID="interview-scroll" class="flex-1 bg-background">
		<View class="gap-4 p-8">
			<Text class="text-xs text-muted-foreground">Mock data. Standalone interview</Text>
			<If when={visible()}>
				<DecisionCard day={day} decision={decision()} index={0} count={1} later={false} />
			</If>
			<View class="flex-row gap-2">
				<Action
					label="Large round"
					onPress={() =>
						decision.set({
							...original,
							interviewRoundId: "round-large",
							interviewQuestions: Array.from({ length: 40 }, (_, n) =>
								question(`q${n}`, "constraints", `Question ${n + 1}: What must stay unchanged?`, [
									{ id: "keep", meaning: "Keep the existing behavior" },
								]),
							),
						})
					}
				/>
				<Action label="Close card" onPress={() => visible.set(false)} />
				<Action label="Reopen card" onPress={reopen} />
				<Action
					label="New round"
					onPress={() => {
						saved.set("");
						decision.set({ ...original, interviewRoundId: "round-2" });
					}}
				/>
			</View>
			<Text class="text-xs text-muted-foreground">{`Saved edits: ${saves()}`}</Text>
			<Text class="text-xs text-muted-foreground">{`Submissions: ${sends()}`}</Text>
			<Text class="text-xs text-muted-foreground">{`Receipt checks: ${checks()}`}</Text>
		</View>
	</Scroll>
));
