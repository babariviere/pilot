// Scripted transport, real Today/chat views. No service, provider or execution.
import { keymap, mount, Scroll, signal, View } from "nsh";
import { TodayFeed } from "pilot-day/native";
import { mirrorDay } from "./app/day";
import { MockDayScreen } from "./app/testing/mockFeeds";
import { mirrorSessionChat, type SessionChat, type SessionChatSource } from "./sessions/sessionChat";
import { mirrorScope, type ScopeMirror, todayProject } from "./today/todayScope";
import { Block, Button, Buttons, Caption, WindowCanvas } from "./ui";

const feed = new TodayFeed("decisions");
const opened = signal("");
const sends = signal(0);
let chat: SessionChat | null = null;
const listeners = new Set<(c: SessionChat | null) => void>();
const source: SessionChatSource = {
	chat: () => chat,
	onChange: (l) => {
		listeners.add(l);
		return () => listeners.delete(l);
	},
	async open(id) {
		opened.set(id);
		chat = {
			sessionId: id,
			title: `Exact chat ${id}`,
			state: "working",
			stateReason: "",
			rows: [],
			more: false,
			reading: false,
			reason: "",
		};
		for (const l of listeners) l(chat);
	},
	async earlier() {},
	async refresh() {},
	close() {
		chat = null;
		for (const l of listeners) l(null);
	},
	async continueChat() {
		sends.update((n) => n + 1);
		return { status: "rejected", message: "No execution in this fixture" };
	},
	async checkContinue() {
		return { status: "unknown", message: "" };
	},
	dispose() {},
};
let rows: {
	sessionId: string;
	title: string;
	missionId: string | null;
	missionTitle: string | null;
	purpose: string | null;
	status: "working";
}[] = [
	{
		sessionId: "mission-agent",
		title: "Native activity",
		missionId: "mission",
		missionTitle: "Daily work",
		purpose: "Show working agents",
		status: "working" as const,
	},
	{
		sessionId: "solo-agent",
		title: "Standalone investigation",
		missionId: null,
		missionTitle: null,
		purpose: null,
		status: "working" as const,
	},
];
let state = "live";
let waiting: {
	sessionId: string;
	title: string;
	missionId: string | null;
	missionTitle: string | null;
	queue: { kind: "slots" | "files"; position: number; holders: string[] };
}[] = [];
let hold = true;
let refusal: "offline" | "invalid" | "stale" | "identity" | null = null;
const held: (() => void)[] = [];
let accessible = true;
// Also loads against the parent renderer for Before captures.
const scope: ScopeMirror & { invalidate?: () => void } = mirrorScope({
	async read(selected, generation) {
		const projects = [
			{ id: "one", name: "pilot" },
			{ id: "two", name: "website" },
		]
			.filter((p) => accessible || p.id !== "two")
			.map((p, i) => ({
				...p,
				selected: selected === "all" || selected === p.id,
				currentness: "live",
				observedAt: "",
				needsYou: { count: 0, complete: true },
				today: null,
				planning: null,
				results: null,
				errors: {},
				canAct: false,
				working: {
					state,
					items: rows.filter((r) => (i === 0) === (r.sessionId !== "solo-agent")),
					waiting: i === 0 ? waiting : [],
				},
			}));
		const snapshot = {
			version: 1,
			scope: selected,
			generation,
			own: "one",
			catalogComplete: true,
			complete: true,
			outsideNeedsYou: { count: 0, complete: true },
			projects,
		};
		if (hold) await new Promise<void>((resolve) => held.push(resolve));
		return refusal ? { ok: false, refusal } : { ok: true, snapshot };
	},
});
const day = mirrorDay(feed, { scope, chat: mirrorSessionChat(source) });
const read = () => void scope.read(todayProject());
function update(run: () => void) {
	run();
	read();
}

function changeTask() {
	update(() => {
		rows = rows.map((r) => (r.sessionId === "mission-agent" ? { ...r, purpose: "Updated task" } : r));
	});
}

/** The queued chat moves up: the chat before it started. */
function moveUp() {
	update(() => {
		waiting = waiting.map((w) => ({ ...w, queue: { ...w.queue, position: 1, holders: ["Native activity"] } }));
	});
}

mount(() => {
	keymap.bind("mod+shift+u", changeTask, { when: "always" });
	keymap.bind("mod+shift+q", moveUp, { when: "always" });
	return (
		<WindowCanvas>
			<View class="flex-1">
				<MockDayScreen day={day} />
			</View>
			<Scroll class="max-h-44">
				<Block>
					<Caption>{`Opened: ${opened()} · Sends: ${sends()}`}</Caption>
					<Buttons>
						<Button
							label="Change task"
							onPress={() =>
								update(() => {
									rows = rows.map((r) =>
										r.sessionId === "mission-agent" ? { ...r, purpose: "Updated task" } : r,
									);
								})
							}
						/>
						<Button
							label="Stop agent"
							onPress={() =>
								update(() => {
									rows = rows.filter((r) => r.sessionId !== "mission-agent");
								})
							}
						/>
						<Button
							label="Queue chat"
							onPress={() =>
								update(() => {
									waiting = [
										{
											sessionId: "queued-agent",
											title: "Queued fix",
											missionId: null,
											missionTitle: null,
											queue: { kind: "slots", position: 2, holders: ["Native activity", "Other work"] },
										},
									];
								})
							}
						/>
						<Button label="Move up" onPress={moveUp} />
						<Button
							label="Start queued"
							onPress={() =>
								update(() => {
									waiting = [];
									rows = [
										...rows,
										{
											sessionId: "queued-agent",
											title: "Queued fix",
											purpose: null,
											missionId: null,
											missionTitle: null,
											status: "working",
										},
									];
								})
							}
						/>
						<Button
							label="Start agent"
							onPress={() =>
								update(() => {
									rows = [
										...rows,
										{
											sessionId: "new-agent",
											title: "New worker",
											purpose: "New task",
											missionId: null,
											missionTitle: null,
											status: "working",
										},
									];
								})
							}
						/>
						<Button
							label="None working"
							onPress={() =>
								update(() => {
									rows = [];
								})
							}
						/>
						<Button
							label="Access lost"
							onPress={() =>
								update(() => {
									accessible = false;
								})
							}
						/>
						<Button
							label="Disconnected"
							onPress={() =>
								update(() => {
									refusal = "offline";
								})
							}
						/>
						<Button
							label="Failed"
							onPress={() =>
								update(() => {
									refusal = "invalid";
								})
							}
						/>
						<Button
							label="Stale"
							onPress={() =>
								update(() => {
									state = "stale";
								})
							}
						/>
						<Button label="Duplicate read" onPress={read} />
						<Button
							label="Start many"
							onPress={() =>
								update(() => {
									rows = [
										...rows,
										...Array.from({ length: 5 }, (_, i) => ({
											sessionId: `extra-${i}`,
											title: `Extra worker ${i}`,
											missionId: null,
											missionTitle: null,
											purpose: "Check native activity",
											status: "working" as const,
										})),
									];
								})
							}
						/>
						<Button label="Invalidate" onPress={() => scope.invalidate?.()} />
						<Button
							label="Identity lost"
							onPress={() =>
								update(() => {
									refusal = "identity";
								})
							}
						/>
						<Button
							label="Restore access"
							onPress={() =>
								update(() => {
									refusal = null;
								})
							}
						/>
						<Button
							label="Hold reads"
							onPress={() => {
								hold = true;
								read();
							}}
						/>
						<Button
							label="Release newer"
							onPress={() => {
								hold = false;
								held.pop()?.();
							}}
						/>
						<Button label="Release older" onPress={() => held.shift()?.()} />
					</Buttons>
				</Block>
			</Scroll>
		</WindowCanvas>
	);
});
