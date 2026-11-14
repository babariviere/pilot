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
import { mount, signal, Text, View } from "nsh";
import type { ChatRow } from "pilot-day/native";
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
} from "./feedbackFeed";
import { MockDayScreen, openDay } from "./mockFeeds";
import { goalDraft } from "./planView";
import { mirrorSessionChat, type SessionChat, type SessionChatSource } from "./sessionChat";
import { Action } from "./ui";
import { captureView, restoreView, startFresh } from "./updateView";

type Next = "accept" | "unknown" | "reject";

const DIGEST = "d".repeat(64);
const PROJECTS = [{ projectId: "pilot", name: "Pilot code", contextDigest: DIGEST }];

/** Saved feedback in memory, newest first, two per page. Nothing leaves the fixture. */
class ScriptedFeedback implements FeedbackSource {
	next = signal<Next>("accept");
	nextStep = signal<Next>("accept");
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

	view(): FeedbackView {
		const items = this.#saved.slice(0, this.#shown);
		return {
			availability: this.#failed ? "unavailable" : this.#shown >= 0 ? "live" : "idle",
			reason: this.#failed ? "Pilot could not reach its service." : "",
			items: this.#failed ? [] : items,
			more: !this.#failed && this.#shown < this.#saved.length,
			unsettled: this.#lost
				? [{ operationId: this.#lost.operationId, state: "unknown", text: this.#lost.intent.text }]
				: [],
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
		} else w = { ...base, kind: intent.action === "resolve" ? "resolved" : "reopened" };
		// An answered triage goes back to work, without its question.
		const work = item.work.map((x): UserFeedbackWorkView => {
			if (intent.action !== "answer" || x.kind !== "triage" || x.sessionId !== intent.triageSessionId) return x;
			const { question: _question, ...rest } = x;
			return { ...rest, chat: { title: "Triage", state: "working" } };
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
	finishTriage(proposal: Partial<UserFeedbackProposal> | "asks") {
		const item = this.#saved[0];
		const t = item?.work.findIndex((w) => w.kind === "triage") ?? -1;
		if (!item || t < 0) return;
		const w = item.work[t]!;
		const others = this.#saved.slice(1).map((i) => i.id);
		const work: UserFeedbackWorkView[] = item.work.map((x, i) =>
			i !== t
				? x
				: proposal === "asks"
					? {
							...w,
							chat: { title: "Triage", state: "question" },
							question: {
								id: 7,
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
								digest: DIGEST,
							},
						},
		);
		this.#saved = [{ ...item, work }, ...this.#saved.slice(1)];
		this.#publish();
	}
	dispose() {
		this.#listeners.clear();
	}
}

const feedback = new ScriptedFeedback();

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
			state: fix ? "done" : "working",
			stateReason: "",
			rows: fix
				? [
						row("10", "you", "Show the assignee on each plan row."),
						row("11", "pilot", "I added the assignee to each plan row."),
						row("11.0", "step", "Read apps/day/PlanScreen.tsx"),
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
	close(sessionId: string) {
		if (this.#chat?.sessionId === sessionId) this.#set(null);
	}
	dispose() {
		this.#listeners.clear();
	}
}

const day = { ...openDay(), feedback: mirrorFeedback(feedback), chat: mirrorSessionChat(new ScriptedChat()) };

const NEXT: Next[] = ["unknown", "reject"];

/** The unsent feedback the last saved window kept. */
const kept = signal("");

mount(() => (
	<View class="flex-1">
		<View class="flex-row flex-wrap items-center gap-1 px-6 pt-2">
			<Text testID="counts">{`Sends: ${feedback.sends()} · Checks: ${feedback.checks()}`}</Text>
			<Each of={NEXT} key={(n) => n}>
				{(n) => <Action label={`Next ${n()}`} onPress={() => feedback.next.set(n())} />}
			</Each>
			<Action label="Unreadable" onPress={() => feedback.unreadable.set(true)} />
			<Action label="Many saved" onPress={() => feedback.manySaved()} />
			<Text testID="steps">{`Steps: [${feedback.steps().join(",")}]`}</Text>
			<Each of={NEXT} key={(n) => n}>
				{(n) => <Action label={`Next step ${n()}`} onPress={() => feedback.nextStep.set(n())} />}
			</Each>
			<Action label="Triage fix" onPress={() => feedback.finishTriage({})} />
			<Action label="Triage asks" onPress={() => feedback.finishTriage("asks")} />
			<Action
				label="Triage new mission"
				onPress={() => feedback.finishTriage({ next: "new-mission", goal: "Make plans show their people" })}
			/>
			<Action
				label="Save and reopen"
				onPress={() => {
					const v = captureView(day.today());
					kept.set(v.feedback ?? "");
					startFresh();
					restoreView(v, undefined, day.today());
				}}
			/>
			<Text testID="kept">{`Kept: [${kept()}]`}</Text>
			<Text testID="goal-draft">{`New goal: [${goalDraft().split("\n")[0]}]`}</Text>
			<Text testID="answer-sent">{`Answer: [${feedback.answer()}]`}</Text>
		</View>
		<MockDayScreen day={day} />
	</View>
));
