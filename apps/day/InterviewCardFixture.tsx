// Mock data only. No account, daemon or real continuation.
import { effect, type JSX, mount, Scroll, signal, View } from "nsh";
import type { Decision, DraftIntent, ReplyIntent } from "pilot-day/native";
import { DecisionCard } from "./DecisionCard";
import { ScopedInterviewCard } from "./InterviewCard";
import { openDay } from "./mockFeeds";
import { Block, Button, Buttons, Caption, Column, GridBackdrop, Page, PageHead, Panel, Section } from "./ui";

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
const snapshot = day.today();
effect(() => day.today.set({ ...snapshot, decisions: [decision()] }));
const visible = signal(true);
const second = signal(false);
const scoped = signal(false);
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

// The selected card receives native draft projection. The scoped card also
// accepts an unsaved draft kept by the window for its exact pin.
function reopen() {
	if (scoped()) {
		visible.set(true);
		return;
	}
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

// LIBRARY GAP: no part paints a window's canvas (the background colour and GridBackdrop) for a fixture that mounts
// a screen or a control without DayScreen. This local root does what DayScreen's root does.
function FixtureWindow(props: { children?: JSX.Element }) {
	return (
		<View class="flex-1 bg-background">
			<GridBackdrop />
			{props.children}
		</View>
	);
}

mount(() => (
	<FixtureWindow>
		<Scroll testID="interview-scroll" class="flex-1">
			<Page>
				<PageHead pre={<Caption>Mock data. Standalone interview</Caption>} title="Interview" />
				<Panel>
					<Column>
						<Section title="Needs you">
							<If when={visible()}>
								<If
									when={scoped()}
									else={<DecisionCard day={day} decision={decision()} index={0} count={1} later={false} />}
								>
									<ScopedInterviewCard
										decision={decision()}
										identity="other-project/question/round-1"
										keyboardActive
										draftText={saved()}
										onSave={(text) => saved.set(text)}
										onSubmit={async (text) => {
											saved.set(text);
											sends.set(sends() + 1);
											decision.set({ ...decision(), delivery: "unknown" });
											return {
												status: "unknown",
												message: "Not confirmed. Check again reads only.",
												revision: 1,
											};
										}}
										onCheck={() => checks.set(checks() + 1)}
									/>
								</If>
							</If>
						</Section>
						<If when={second()}>
							<View testID="secondary-round">
								<DecisionCard
									day={day}
									index={1}
									count={2}
									later={false}
									decision={{
										...original,
										id: "second-round",
										interviewRoundId: "second-round",
										interviewQuestions: original.interviewQuestions.map((q) => ({
											...q,
											id: `other-${q.id}`,
										})),
									}}
								/>
							</View>
						</If>
					</Column>
				</Panel>
				<Block>
					<Buttons>
						<Button label="Show second round" onPress={() => second.set(true)} />
						<Button
							label="Stale global read"
							onPress={() =>
								day.today.set({ ...day.today(), attention: { ...day.today().attention, state: "stale" } })
							}
						/>
						<Button
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
						<Button label="Close card" onPress={() => visible.set(false)} />
						<Button label="Reopen card" onPress={reopen} />
						<Button
							label="New round"
							onPress={() => {
								saved.set("");
								decision.set({ ...original, interviewRoundId: "round-2" });
							}}
						/>
						<Button label="Open other project's round" onPress={() => scoped.set(true)} />
					</Buttons>
					<Caption>{`Saved edits: ${saves()}`}</Caption>
					<Caption>{`Submissions: ${sends()}`}</Caption>
					<Caption>{`Receipt checks: ${checks()}`}</Caption>
				</Block>
			</Page>
		</Scroll>
	</FixtureWindow>
));
