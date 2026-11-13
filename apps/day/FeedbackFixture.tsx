// Headless fixture only. No daemon, worker, provider or storage. The
// feedback page over a scripted in-memory source: `Next …` picks what the
// next Send does, "Unreadable" makes reads fail, "Many saved" fills older
// pages, and "Save and reopen" keeps the window as a close or an update
// saves it and shows it again in a fresh window state.
import { mount, signal, Text, View } from "nsh";
import {
	type FeedbackItem,
	type FeedbackSource,
	type FeedbackView,
	mirrorFeedback,
	refusedSend,
	type SendIntent,
	type SendResult,
	type UserFeedbackOrigin,
} from "./feedbackFeed";
import { MockDayScreen, openDay } from "./mockFeeds";
import { Action } from "./ui";
import { captureView, restoreView, startFresh } from "./updateView";

type Next = "accept" | "unknown" | "reject";

/** Saved feedback in memory, newest first, two per page. Nothing leaves the fixture. */
class ScriptedFeedback implements FeedbackSource {
	next = signal<Next>("accept");
	unreadable = signal(false);
	sends = signal(0);
	checks = signal(0);
	#saved: FeedbackItem[] = [];
	#shown = 0;
	#lost: { operationId: string; intent: SendIntent } | null = null;
	#sending = false;
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
			reading: false,
			sending: this.#sending,
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
			origin: this.#origin(intent),
			recordedAt: Date.UTC(2026, 10, 13, 12),
			operationId,
			sequence: this.#sequence,
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
	dispose() {
		this.#listeners.clear();
	}
}

const feedback = new ScriptedFeedback();
const day = { ...openDay(), feedback: mirrorFeedback(feedback) };

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
		</View>
		<MockDayScreen day={day} />
	</View>
));
