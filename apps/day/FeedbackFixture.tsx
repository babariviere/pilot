// Headless fixture only. No daemon, worker, provider or storage. The
// feedback page over a scripted in-memory source: `Next …` picks what the
// next Send does, "Unreadable" makes reads fail, "Many saved" fills older
// pages, and "Save and reopen" keeps the window as a close or an update
// saves it and shows it again in a fresh window state. "Triage …" finishes
// the newest item's triage with a scripted proposal; "Next step …" picks
// what the next step does. "Triage asks" leaves it waiting on a question; an
// answer puts it back to work, and "Answer:" shows the last words sent.
// A triage or fix chat opens as a scripted read-only chat: a triage chat
// works, a fix chat is done and has an earlier page.
// "Triage prototype" proposes a prototype; "Prototype asks" leaves the
// prototype waiting on a choice with two mockups; "Prototype chose" finishes
// it with the chosen fix. Mockups read from a scripted artifact source.
import { mount, signal, View } from "nsh";
import type { ChatRow } from "pilot-day/native";
import { MockDayScreen, openDay } from "./app/testing/mockFeeds";
import { captureView, restoreView, startFresh } from "./app/windowState";
import type { ArtifactRow, ArtifactSource, ListResult, ReadResult } from "./artifacts/artifactReads";
import {
	type FeedbackItem,
	type FeedbackSource,
	type FeedbackStepOp,
	type FeedbackView,
	mirrorFeedback,
	refusedSend,
	refusedStep,
	type SendIntent,
	type SendResult,
	type StepIntent,
	type StepResult,
	type UserFeedbackOrigin,
	type UserFeedbackProposal,
	type UserFeedbackWorkView,
} from "./feedback/feedbackFeed";
import { openFeedbackWith } from "./feedback/feedbackView";
import { goalDraft } from "./missions/planning/planView";
import { mirrorSessionChat, type SessionChat, type SessionChatSource } from "./sessions/sessionChat";
import { Block, Button, Buttons, Caption } from "./ui";

type Next = "accept" | "unknown" | "reject";

const DIGEST = "d".repeat(64);
const PROJECTS = [{ projectId: "pilot", name: "Pilot code", contextDigest: DIGEST }];
const FIX_SETUP = { digest: DIGEST, model: "Sonnet", thinking: "medium", allowanceMicros: 2_000_000 };

/** Saved feedback in memory, newest first, two per page. Nothing leaves the fixture. */
class ScriptedFeedback implements FeedbackSource {
	next = signal<Next>("accept");
	nextStep = signal<Next>("accept");
	rejectCheck = signal(false);
	unreadable = signal(false);
	sends = signal(0);
	checks = signal(0);
	steps = signal<string[]>([]);
	answer = signal("");
	#saved: FeedbackItem[] = [];
	#shown = 0;
	#lost: { operationId: string; intent: SendIntent } | null = null;
	#lostStep: { operationId: string; intent: StepIntent } | null = null;
	#sending = false;
	#projects: typeof PROJECTS | null = null;
	#failed = false;
	#listeners = new Set<(view: FeedbackView) => void>();
	#sequence = 0;
	#finished = new Map<string, number>();

	view(): FeedbackView {
		const items = this.#saved.slice(0, this.#shown);
		return {
			availability: this.#failed ? "unavailable" : this.#shown >= 0 ? "live" : "idle",
			reason: this.#failed ? "Pilot could not reach its service." : "",
			items: this.#failed ? [] : items,
			more: !this.#failed && this.#shown < this.#saved.length,
			unsettled: this.#lost ? [{ ...this.#lost.intent, operationId: this.#lost.operationId, state: "unknown" }] : [],
			unsettledSteps: this.#lostStep
				? [
						{
							operationId: this.#lostStep.operationId,
							state: "unknown",
							feedbackId: this.#lostStep.intent.feedbackId,
							step: this.#lostStep.intent.action,
						} satisfies FeedbackStepOp,
					]
				: [],
			projects: this.#projects,
			reading: false,
			sending: this.#sending,
			stepping: null,
		};
	}
	onChange(listener: (view: FeedbackView) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	#publish() {
		for (const l of this.#listeners) l(this.view());
	}
	#origin(intent: SendIntent): UserFeedbackOrigin | null {
		const o = intent.origin;
		if (!o) return null;
		return o.kind === "mission"
			? { ...o, projectId: "mock-project", title: `Mission ${o.missionId}` }
			: { ...o, projectId: "mock-project", title: "A chat" };
	}
	#save(intent: SendIntent, operationId: string): FeedbackItem {
		this.#sequence += 1;
		const item = {
			id: `f${this.#sequence}`,
			text: intent.text,
			...(intent.attachments ? { attachments: intent.attachments } : {}),
			origin: this.#origin(intent),
			recordedAt: Date.UTC(2026, 10, 13, 12),
			operationId,
			sequence: this.#sequence,
			work: [],
		};
		this.#saved = [item, ...this.#saved];
		this.#shown = Math.min(this.#saved.length, Math.max(2, this.#shown + 1));
		return item;
	}
	async read() {
		this.#failed = this.unreadable();
		this.#shown = Math.min(this.#saved.length, 2);
		this.#publish();
	}
	async more() {
		this.#shown = Math.min(this.#saved.length, this.#shown + 2);
		this.#publish();
	}
	async send(intent: SendIntent): Promise<SendResult> {
		this.sends.update((n) => n + 1);
		const mode = this.next();
		this.next.set("accept");
		const operationId = `op-${this.sends()}`;
		if (mode === "reject") return refusedSend("offline");
		if (mode === "unknown") {
			this.#lost = { operationId, intent };
			this.#publish();
			return refusedSend("lost");
		}
		const saved = this.#save(intent, operationId);
		this.#publish();
		return { status: "accepted", message: "Saved. Thank you.", operationId, saved };
	}
	async check(operationId: string): Promise<SendResult> {
		this.checks.update((n) => n + 1);
		const lost = this.#lost;
		if (!lost || lost.operationId !== operationId) return refusedSend("unknown");
		this.#lost = null;
		if (this.rejectCheck()) {
			this.rejectCheck.set(false);
			this.#publish();
			return {
				status: "rejected",
				message: "The service rejected this feedback. Your text stays.",
				operationId,
				saved: null,
			};
		}
		const saved = this.#save(lost.intent, operationId);
		this.#publish();
		return { status: "accepted", message: "Saved. Thank you.", operationId, saved };
	}
	manySaved() {
		for (let n = 0; n < 5; n++) this.#save({ text: `Older note ${n + 1}`, origin: null }, `old-${n}`);
		this.#shown = 2;
		this.#publish();
	}
	async readProjects() {
		this.#projects = PROJECTS;
		this.#publish();
	}
	#apply(intent: StepIntent, operationId: string) {
		const item = this.#saved.find((i) => i.id === intent.feedbackId);
		if (!item) return;
		if (intent.action === "remove") {
			this.#saved = this.#saved.filter((i) => i !== item);
			return;
		}
		const base = { operationId, recordedAt: Date.UTC(2026, 10, 13, 13) };
		const n = this.steps().length;
		let w: UserFeedbackWorkView;
		if (intent.action === "triage")
			w = {
				...base,
				kind: "triage",
				sessionId: `triage-${n}`,
				projectId: intent.projectId,
				chat: { title: "Triage", state: "working" },
			};
		else if (intent.action === "fix")
			w = {
				...base,
				kind: "fix",
				sessionId: `fix-${n}`,
				projectId: intent.projectId,
				triageSessionId: intent.triageSessionId,
				proposalDigest: intent.proposalDigest,
				chat: { title: "Fix", state: "working" },
			};
		else if (intent.action === "prototype")
			w = {
				...base,
				kind: "prototype",
				sessionId: `prototype-${n}`,
				projectId: intent.projectId,
				triageSessionId: intent.triageSessionId,
				proposalDigest: intent.proposalDigest,
				chat: { title: "Prototype", state: "working" },
			};
		else if (intent.action === "link")
			w = {
				...base,
				kind: "mission",
				missionId: intent.missionId,
				projectId: "pilot",
				mission: { title: `Mission ${intent.missionId}`, status: "active", tasksDone: 1, tasksTotal: 4 },
			};
		else if (intent.action === "answer") {
			this.answer.set(intent.message);
			w = {
				...base,
				kind: "answer",
				sessionId: intent.triageSessionId,
				questionId: intent.questionId,
				text: intent.message,
			};
		} else if (intent.action === "correct") {
			this.answer.set(intent.message);
			w = {
				...base,
				kind: "correction",
				sessionId: intent.triageSessionId,
				proposalDigest: intent.proposalDigest,
				text: intent.message,
			};
		} else w = { ...base, kind: intent.action === "resolve" ? "resolved" : "reopened" };
		// An answered chat goes back to work, without its question.
		const work = item.work.map((x): UserFeedbackWorkView => {
			if (
				(intent.action !== "answer" && intent.action !== "correct") ||
				(x.kind !== "triage" && x.kind !== "prototype" && x.kind !== "fix") ||
				x.sessionId !== intent.triageSessionId
			)
				return x;
			const { question: _question, proposal: _proposal, ...rest } = x;
			return { ...rest, chat: { title: x.chat?.title ?? "Triage", state: "working" } };
		});
		this.#saved = this.#saved.map((i) => (i === item ? { ...i, work: [...work, w] } : i));
	}
	async step(intent: StepIntent): Promise<StepResult> {
		if (this.#lostStep) return refusedStep("unknown");
		this.steps.update((s) => [...s, intent.action]);
		const mode = this.nextStep();
		this.nextStep.set("accept");
		const operationId = `step-${this.steps().length}`;
		if (mode === "reject") return refusedStep("stale");
		if (mode === "unknown") {
			this.#lostStep = { operationId, intent };
			this.#publish();
			return refusedStep("lost");
		}
		this.#apply(intent, operationId);
		this.#publish();
		return { status: "accepted", message: "" };
	}
	async checkStep(operationId: string): Promise<StepResult> {
		this.checks.update((n) => n + 1);
		const lost = this.#lostStep;
		if (!lost || lost.operationId !== operationId) return refusedStep("lost");
		this.#lostStep = null;
		this.#apply(lost.intent, operationId);
		this.#publish();
		return { status: "accepted", message: "" };
	}
	/** Finishes the newest item's triage with `proposal`, or leaves it asking. */
	finishTriage(proposal: Partial<UserFeedbackProposal> | "asks" | "multiple" | "unusable") {
		const item = this.#saved[0];
		const t = item?.work.findIndex((w) => w.kind === "triage") ?? -1;
		if (!item || t < 0) return;
		const version =
			proposal === "asks" || proposal === "multiple"
				? (this.#finished.get(item.id) ?? 0)
				: (this.#finished.get(item.id) ?? 0) + 1;
		this.#finished.set(item.id, version);
		const digest = version <= 1 ? DIGEST : version.toString(16).padStart(64, "e");
		const w = item.work[t]!;
		const others = this.#saved.slice(1).map((i) => i.id);
		const work: UserFeedbackWorkView[] = item.work.map((x, i) =>
			i !== t
				? x
				: proposal === "unusable"
					? {
							...w,
							chat: { title: "Triage", state: "done" },
							proposal: {
								problem: "The last answer is not a usable proposal",
								raw: "The filter belongs to the search improvements. Keep the filter when Pilot reopens.",
								digest,
							},
						}
					: proposal === "asks" || proposal === "multiple"
						? {
								...w,
								chat: { title: "Triage", state: "question" },
								question: {
									id: 7,
									multiSelect: proposal === "multiple",
									question: "Which page do you mean?",
									context: "Plans and missions both list tasks.",
									options: [
										{ label: "The plan page", suggested: true },
										{ label: "Mission overview", detail: "The task list on a mission" },
									],
								},
							}
						: {
								...w,
								chat: { title: "Triage", state: "done" },
								fixSetup: FIX_SETUP,
								proposal: {
									value: {
										summary: "The plan page hides who works on each task.",
										duplicates: others.slice(0, 1),
										next: "fix",
										detail: "Show the assignee on each plan row and check it in Plan.test.tsx.",
										missionId: null,
										goal: null,
										...proposal,
									},
									digest,
								},
							},
		);
		this.#saved = [{ ...item, work }, ...this.#saved.slice(1)];
		this.#publish();
	}
	/** Leaves the newest item's prototype asking which mockup to build, or finishes it with the choice. */
	prototype(state: "asks" | "chose") {
		const item = this.#saved[0];
		const t = item?.work.findIndex((w) => w.kind === "prototype") ?? -1;
		if (!item || t < 0) return;
		const w = item.work[t]!;
		if (w.kind !== "prototype") return;
		const mockups = MOCKUPS.map((m) => ({ ...m, sessionId: w.sessionId }));
		const next: UserFeedbackWorkView =
			state === "asks"
				? {
						...w,
						chat: { title: "Prototype", state: "question" },
						question: {
							id: 9,
							question: "Which one should Pilot build?",
							options: [{ label: "Inline owner chips", suggested: true }, { label: "Owner column" }],
							artifacts: mockups,
						},
					}
				: {
						...w,
						chat: { title: "Prototype", state: "done" },
						fixSetup: FIX_SETUP,
						proposal: {
							value: {
								summary: "Inline owner chips on plan rows.",
								duplicates: [],
								next: "fix",
								detail: "Add an owner chip after each task title, as in the chosen mockup.",
								missionId: null,
								goal: null,
								mockup: mockups[0]!,
							},
							digest: "c".repeat(64),
						},
					};
		this.#saved = [{ ...item, work: item.work.map((x, i) => (i === t ? next : x)) }, ...this.#saved.slice(1)];
		this.#publish();
	}
	dispose() {
		this.#listeners.clear();
	}
}

const feedback = new ScriptedFeedback();

const MOCKUPS = [
	{ artifactId: "m-chips", title: "Inline owner chips", kind: "nsh", revision: 2 },
	{ artifactId: "m-column", title: "Owner column", kind: "nsh", revision: 1 },
];

/** Mockups as inert text. Opening one reads it once; it sends nothing. */
const mockupReads = signal<string[]>([]);
const artifacts: ArtifactSource = {
	async list(): Promise<ListResult> {
		return { ok: true, list: { rows: [], more: false } };
	},
	async read(row: ArtifactRow): Promise<ReadResult> {
		mockupReads.update((all) => [...all, `${row.artifactId}@${row.revision}`]);
		const text = "export default () => <Text>Owner chips</Text>;";
		return {
			status: "shown",
			artifact: {
				version: 1,
				reference: { sourceSessionId: row.sessionId, artifactId: row.artifactId, revision: row.revision ?? 0 },
				metadata: { title: row.title, kind: row.kind },
				rendering: "unsupported",
				content: { state: "text", source: text, containerSha256: "a".repeat(64), containerBytes: text.length },
			},
		};
	},
};

const row = (key: string, role: ChatRow["role"], text: string): ChatRow => ({
	key,
	role,
	text,
	shortened: false,
	running: false,
	failed: false,
});

/** Invented chats in memory, read only. A fix chat has one earlier page. */
class ScriptedChat implements SessionChatSource {
	#chat: SessionChat | null = null;
	#listeners = new Set<(chat: SessionChat | null) => void>();
	/** Fix chats open stopped; Continue sends once and sets them working. */
	stopped = signal(false);
	continues = signal(0);
	chat() {
		return this.#chat;
	}
	onChange(listener: (chat: SessionChat | null) => void) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	#set(chat: SessionChat | null) {
		this.#chat = chat;
		for (const l of this.#listeners) l(chat);
	}
	async open(sessionId: string) {
		this.#set(null);
		await Promise.resolve();
		const fix = sessionId.startsWith("fix-");
		this.#set({
			sessionId,
			title: fix ? "Fix: show plan assignees" : "Triage",
			state: fix ? (this.stopped() ? "stopped" : "done") : "working",
			stateReason: "",
			canContinue: fix && this.stopped(),
			rows: fix
				? [
						row("10", "you", "Show the assignee on each plan row."),
						row("11", "pilot", "I added the assignee to each plan row."),
						row("11.0", "step", "Read apps/day/missions/planning/PlanScreen.tsx"),
						row("12", "pilot", "Plan.test.tsx passes."),
					]
				: [row("4", "you", "Triage this feedback.")],
			more: fix,
			reading: false,
			reason: "",
		});
	}
	async earlier() {
		const now = this.#chat;
		if (!now?.more) return;
		this.#set({ ...now, rows: [row("3", "you", "Earlier words"), ...now.rows], more: false });
	}
	async refresh() {}
	async continueChat(sessionId: string) {
		const now = this.#chat;
		if (now?.sessionId !== sessionId || now.state !== "stopped")
			return {
				status: "rejected" as const,
				message: "Pilot's service refused it: Only a stopped chat can continue.",
			};
		this.continues.update((n) => n + 1);
		this.#set({ ...now, state: "working", canContinue: false });
		return { status: "accepted" as const, message: "", operationId: "continue-1" };
	}
	async checkContinue(operationId: string) {
		return { status: "unknown" as const, message: "Not confirmed.", operationId };
	}
	close(sessionId: string) {
		if (this.#chat?.sessionId === sessionId) this.#set(null);
	}
	dispose() {
		this.#listeners.clear();
	}
}

const scriptedChat = new ScriptedChat();
const day = { ...openDay(), feedback: mirrorFeedback(feedback), chat: mirrorSessionChat(scriptedChat), artifacts };

const NEXT: Next[] = ["unknown", "reject"];

/** The unsent feedback the last saved window kept. */
const kept = signal("");

mount(() => (
	<View class="flex-1">
		<Block gap={1}>
			<Buttons>
				<Caption testID="counts">{`Sends: ${feedback.sends()} · Checks: ${feedback.checks()}`}</Caption>
				<Each of={NEXT} key={(n) => n}>
					{(n) => <Button small label={`Next ${n()}`} onPress={() => feedback.next.set(n())} />}
				</Each>
				<Button small label="Unreadable" onPress={() => feedback.unreadable.set(true)} />
				<Button small label="Many saved" onPress={() => feedback.manySaved()} />
				<Button small label="Check rejects" onPress={() => feedback.rejectCheck.set(true)} />
				<Button
					small
					label="Suggested feedback"
					onPress={() => openFeedbackWith({ kind: "mission", missionId: "search" }, "Suggested report")}
				/>
				<Caption testID="steps">{`Steps: [${feedback.steps().join(",")}]`}</Caption>
				<Each of={NEXT} key={(n) => n}>
					{(n) => <Button small label={`Next step ${n()}`} onPress={() => feedback.nextStep.set(n())} />}
				</Each>
				<Button small label="Triage fix" onPress={() => feedback.finishTriage({})} />
				<Button small label="Triage asks" onPress={() => feedback.finishTriage("asks")} />
				<Button small label="Triage multiple" onPress={() => feedback.finishTriage("multiple")} />
				<Button small label="Triage unusable" onPress={() => feedback.finishTriage("unusable")} />
				<Button
					small
					label="Triage new mission"
					onPress={() => feedback.finishTriage({ next: "new-mission", goal: "Make plans show their people" })}
				/>
				<Button
					small
					label="Triage prototype"
					onPress={() =>
						feedback.finishTriage({
							next: "prototype",
							detail: "Where a plan row shows who works on the task.",
							directions: ["Inline owner chips", "An owner column"],
						})
					}
				/>
				<Button small label="Prototype asks" onPress={() => feedback.prototype("asks")} />
				<Button small label="Prototype chose" onPress={() => feedback.prototype("chose")} />
				<Caption testID="mockup-reads">{`Mockup reads: [${mockupReads().join(",")}]`}</Caption>
				<Button
					small
					label="Save and reopen"
					onPress={() => {
						const v = captureView(day.today());
						kept.set(v.feedback ?? "");
						startFresh();
						restoreView(v, undefined, day.today());
					}}
				/>
				<Caption testID="kept">{`Kept: [${kept()}]`}</Caption>
				<Caption testID="goal-draft">{`New goal: [${goalDraft().split("\n")[0]}]`}</Caption>
				<Caption testID="answer-sent">{`Answer: [${feedback.answer()}]`}</Caption>
				<Button small label="Fix stops" onPress={() => scriptedChat.stopped.set(true)} />
				<Caption testID="continues">{`Continues: ${scriptedChat.continues()}`}</Caption>
			</Buttons>
		</Block>
		<MockDayScreen day={day} />
	</View>
));
