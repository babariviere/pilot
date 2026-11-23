// Mock data only. No account, daemon or real continuation.
import { effect, mount, Scroll, signal, View } from "nsh";
import type { Decision, DraftIntent, ReplyIntent } from "pilot-day/native";
import { openDay } from "./app/testing/mockFeeds";
import { ScopedInterviewCard } from "./missions/interviews/InterviewCard";
import { ScopedQuestion } from "./missions/interviews/ScopedQuestion";
import { DecisionCard } from "./today/DecisionCard";
import { Block, Button, Buttons, Caption, Column, Page, PageHead, Panel, Section, WindowCanvas } from "./ui";

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
const openDraftEditor = signal(false);
const inlineDraftEditor = signal(false);
const saved = signal("");
const saves = signal(0);
const sends = signal(0);
const checks = signal(0);
const selector = { projectId: "other-project", decisionId: "question-chat-1", interviewRoundId: "round-1" };
const target = { selector, pin: "a".repeat(64) };
let sharedDraft: { text: string; revision: number } | null = null;
let conflictNextSave = false;
async function serveDraft(command: Parameters<NonNullable<Parameters<typeof ScopedQuestion>[0]["request"]>>[0]) {
	switch (command.kind) {
		case "open":
			return {
				state: "ready" as const,
				target,
				decision: { ...original, draft: { ...original.draft, text: sharedDraft?.text ?? "" } },
				draftRevision: sharedDraft?.revision ?? null,
			};
		case "save":
			if (conflictNextSave) {
				conflictNextSave = false;
				sharedDraft = { text: "", revision: (sharedDraft?.revision ?? 0) + 1 };
			}
			if (command.draftRevision !== (sharedDraft?.revision ?? null)) return { state: "draft-conflict" as const };
			sharedDraft = { text: command.answer.text, revision: (sharedDraft?.revision ?? 0) + 1 };
			saves.update((n) => n + 1);
			return { state: "saved" as const, draftRevision: sharedDraft.revision };
		case "send":
			if (command.draftRevision !== sharedDraft?.revision || command.answer.text !== sharedDraft?.text)
				return { state: "rejected" as const, operationId: "answer" };
			sends.update((n) => n + 1);
			return { state: "accepted" as const, operationId: "answer" };
		default:
			return null;
	}
}
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

mount(() => (
	<WindowCanvas>
		<If when={openDraftEditor()} else={<CardFixtures />}>
			<ScopedQuestion
				place={{ ...selector, projectName: "Other project" }}
				onBack={() => openDraftEditor.set(false)}
				onAnswered={() => openDraftEditor.set(false)}
				inline={
					inlineDraftEditor()
						? { keyboardActive: true, anchor() {}, onFocus() {}, onLater: () => openDraftEditor.set(false) }
						: undefined
				}
				request={serveDraft}
			/>
			<Block>
				<Button label="Leave interview" onPress={() => openDraftEditor.set(false)} />
				<Caption>{`Saved edits: ${saves()}`}</Caption>
			</Block>
		</If>
	</WindowCanvas>
));

function CardFixtures() {
	return (
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
						<Button
							label="Open shared draft"
							onPress={() => {
								inlineDraftEditor.set(false);
								openDraftEditor.set(true);
							}}
						/>
						<Button
							label="Open Today's draft"
							onPress={() => {
								inlineDraftEditor.set(true);
								openDraftEditor.set(true);
							}}
						/>
						<Button
							label="Save in another window on next edit"
							onPress={() => {
								conflictNextSave = true;
								inlineDraftEditor.set(false);
								openDraftEditor.set(true);
							}}
						/>
					</Buttons>
					<Caption>{`Saved edits: ${saves()}`}</Caption>
					<Caption>{`Submissions: ${sends()}`}</Caption>
					<Caption>{`Receipt checks: ${checks()}`}</Caption>
				</Block>
			</Page>
		</Scroll>
	);
}
