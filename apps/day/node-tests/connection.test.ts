// Node characterization of connection ownership. NSH presentation is not rendered.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stubNsh } from "./nsh-stub.ts";

const dayModule = (name: string) => new URL(`../${name}.ts`, import.meta.url).href;

const listeners = new Map<string, (payload: unknown) => void>();
const calls: { name: string; args: unknown }[] = [];
const replies = new Map<string, () => unknown>();
const timers = new Map<number, { run: () => void; delay: number }>();
let timer = 0;
let glides = 0;
const host = {
	params: { day: { version: 1, window: "window" } },
	on(name: string, listen: (payload: unknown) => void) {
		assert.equal(listeners.has(name), false, "one window listener per event");
		listeners.set(name, listen);
	},
	async call(name: string, envelope: { args: unknown }) {
		calls.push({ name, args: envelope.args });
		return (await replies.get(name)?.()) ?? { version: 1, error: "unavailable" };
	},
};
Object.assign(globalThis, {
	setTimeout(run: () => void, delay: number) {
		const id = ++timer;
		timers.set(id, { run, delay });
		return id;
	},
	clearTimeout(id: number) {
		timers.delete(id);
	},
});
stubNsh(
	host,
	{ "./ui": ["glide"] },
	{
		glide: () => {
			glides++;
		},
		fundingAmount: () => null,
		savedQuestionHelp: () => [],
	},
);

const ok = (snapshot: unknown) => ({ version: 1, value: { snapshot } });
const count = (name: string) => calls.filter((call) => call.name === name).length;
async function settle() {
	for (let n = 0; n < 100; n++) await Promise.resolve();
}
function runTimer() {
	assert.equal(timers.size, 1, "one scheduled wake-up");
	const [id, pending] = [...timers][0]!;
	timers.delete(id);
	pending.run();
}
function emit(name: string, extra: Record<string, unknown> = {}) {
	listeners.get(name)?.({ version: 1, window: "window", ...extra });
}

test("opening coalesces retries, keeps startup once and acknowledges only the latest flush", async () => {
	let answer!: (reply: unknown) => void;
	replies.set(
		"day.today.read",
		() =>
			new Promise((resolve) => {
				answer = resolve;
			}),
	);
	const saved = { place: "new", goal: "Exact 👩🏽‍💻  words\nkept" };
	replies.set("day.window.read", () => ok(saved));
	const connection = await import(dayModule("connection"));
	await settle();
	assert.equal(count("day.today.read"), 1);
	emit("day.flush", { generation: 4 });
	emit("day.flush", { generation: 5 });
	emit("day.changed");
	void connection.readAgain();
	assert.equal(timers.size, 0, "a notice while opening needs no separate refresh");
	assert.equal(count("day.flush.ack"), 0);
	assert.equal(count("day.today.read"), 1);
	answer({ version: 1, error: "offline" });
	await settle();
	assert.equal(connection.connection().state, "waiting");
	assert.deepEqual(calls.find((c) => c.name === "day.flush.ack")?.args, { generation: 5, view: saved });
	emit("day.flush", { generation: 5 });
	emit("day.flush", { generation: 4 });
	assert.equal(count("day.flush.ack"), 1);
	assert.deepEqual(
		[...timers.values()].map((t) => t.delay),
		[2000], // The shared backoff (freshness.ts): 2 s first, so a read an event started lands first.
	);
	void connection.readAgain();
	await settle();
	assert.equal(timers.size, 0);
	assert.equal(count("day.today.read"), 2);
	assert.equal(count("day.attention.read"), 1);
	assert.equal(count("day.ritual.read"), 1);
	host.params.day.window = "changed";
	answer(ok({ revision: 9 }));
	await settle();
	assert.equal(connection.connection().state, "none");
	assert.equal(count("day.plan.prepare"), 0, "old completion cannot admit another window");
	assert.equal(timers.size, 0);
});

function reset() {
	glides = 0;
	listeners.clear();
	calls.length = 0;
	replies.clear();
	timers.clear();
	host.params.day.window = "window";
}

const today = (size = 0) => ({
	revision: 1,
	decisions: [],
	actions: [],
	moving: Array.from({ length: size }, (_, n) => ({ id: `mission-${n}` })),
	notMoving: [],
	unreported: [],
	intake: { requests: [] },
	freshness: { state: "live", age: "", reason: "" },
	attention: { state: "live", age: "", reason: "" },
});

test("a refused saved view disposes its entire attempt before retry", async () => {
	reset();
	const { ConnectedToday } = await import(dayModule("todayFeed"));
	const { ConnectedPlans } = await import(dayModule("planFeed"));
	const { ConnectedIntake } = await import(dayModule("intakeFeed"));
	const { ConnectedFeedback } = await import(dayModule("feedbackFeed"));
	const adapters = [ConnectedToday, ConnectedPlans, ConnectedIntake, ConnectedFeedback];
	for (const [module, name] of [
		["deliveryFeed", "ConnectedDelivery"],
		["linearFeed", "ConnectedLinear"],
		["threadFeed", "ConnectedThreads"],
		["sessionChat", "ConnectedSessionChat"],
		["chatFeed", "ConnectedChats"],
		["ritualFeed", "ConnectedRituals"],
	])
		adapters.push((await import(dayModule(module!)))[name!]);
	const disposed: string[] = [];
	const restore: (() => void)[] = [];
	const rituals: unknown[] = [];
	for (const Adapter of adapters) {
		const dispose = Adapter.prototype.dispose;
		Adapter.prototype.dispose = function (this: unknown) {
			disposed.push(Adapter.name);
			if (Adapter.name === "ConnectedRituals") rituals.push(this);
			return dispose.call(this);
		};
		restore.push(() => {
			Adapter.prototype.dispose = dispose;
		});
	}
	try {
		let feedbackAnswer!: (value: unknown) => void;
		let feedbackPublished = 0;
		const readFeedback = ConnectedFeedback.prototype.read;
		ConnectedFeedback.prototype.read = function (
			this: { onChange: (listener: () => void) => void },
			...args: unknown[]
		) {
			this.onChange(() => feedbackPublished++);
			return readFeedback.apply(this, args);
		};
		restore.push(() => {
			ConnectedFeedback.prototype.read = readFeedback;
		});
		replies.set(
			"day.feedback.read",
			() =>
				new Promise((resolve) => {
					feedbackAnswer = resolve;
				}),
		);
		replies.set("day.today.read", () => ok(today()));
		replies.set("day.plan.inventory", () => ok({ availability: "live", plans: [] }));
		const connection = await import(`${dayModule("connection")}?refused-view`);
		await settle();
		assert.equal(connection.connection().state, "waiting");
		assert.deepEqual(
			disposed.sort(),
			adapters
				.filter((adapter) => adapter.name !== "ConnectedRituals")
				.map((adapter) => adapter.name)
				.sort(),
			"the attempt closes its feeds, but the window owns the startup ritual source",
		);
		const firstPublished = feedbackPublished;
		feedbackAnswer(ok({ items: [], more: false, before: null }));
		await settle();
		assert.equal(feedbackPublished, firstPublished, "late feedback cannot publish from a closed attempt");
		assert.equal(count("day.window.read"), 1);
		let answer!: (reply: unknown) => void;
		replies.set(
			"day.window.read",
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		void connection.readAgain();
		await settle();
		assert.equal(count("day.attention.read"), 1);
		assert.equal(count("day.ritual.read"), 1);
		host.params.day.window = "changed";
		answer(ok(null));
		await settle();
		assert.equal(connection.connection().state, "none");
		assert.equal(disposed.length, adapters.length * 2 - 1, "the invalidated second graph is also disposed once");
		assert.equal(rituals.length, 1, "only invalidating the window closes the startup ritual source");
		const secondPublished = feedbackPublished;
		feedbackAnswer(ok({ items: [], more: false, before: null }));
		await settle();
		assert.equal(feedbackPublished, secondPublished);
		assert.equal(timers.size, 0);
	} finally {
		for (const putBack of restore) putBack();
	}
});

test("automatic retry delays and the warning after 3 tries preserve the startup owner", async () => {
	reset();
	replies.set("day.today.read", () => ({ version: 1, error: "offline" }));
	const connection = await import(`${dayModule("connection")}?retry-budget`);
	await settle();
	// The shared backoff, capped at one read a minute. It looks like opening for 3 tries,
	// then says why nothing shows, and keeps trying by itself ("Live data in the UI").
	for (const [n, delay] of [2000, 4000, 8000, 16000, 32000, 60000].entries()) {
		assert.equal(connection.connection().state, n < 3 ? "waiting" : "none");
		assert.equal(timers.size, 1);
		assert.equal([...timers.values()][0]?.delay, delay);
		runTimer();
		await settle();
	}
	assert.equal(connection.connection().state, "none");
	assert.equal(count("day.today.read"), 7);
	assert.equal(count("day.attention.read"), 1);
	assert.equal(count("day.ritual.read"), 1);
	assert.equal(timers.size, 1, "it keeps trying");
});

test("admission retains one graph through invalidations and flush, then closes it once", async () => {
	reset();
	replies.set("day.today.read", () => ok(today()));
	replies.set("day.plan.inventory", () => ok({ availability: "live", plans: [] }));
	replies.set("day.plan.inventorySnapshot", () => ok({ availability: "live", plans: [] }));
	replies.set("day.window.read", () => ok(null));
	replies.set("day.update.read", () => ok({ revision: 1, restore: null }));
	const connection = await import(`${dayModule("connection")}?admitted`);
	await settle();
	const opened = connection.connection();
	assert.equal(opened.state, "open");
	const closed: string[] = [];
	for (const name of ["day", "plans", "rituals", "update"]) {
		const owned = opened[name];
		const close = owned.close;
		owned.close = () => {
			closed.push(name);
			close();
		};
	}
	const reads = count("day.today.read");
	emit("day.changed");
	emit("day.changed");
	assert.equal(count("day.today.read"), reads, "notices schedule one read rather than reading inline");
	runTimer();
	await settle();
	assert.equal(connection.connection(), opened);
	assert.equal(closed.length, 0);
	assert.equal(count("day.today.read"), reads + 1);
	emit("day.flush", { generation: 9 });
	emit("day.flush", { generation: 10 });
	await settle();
	assert.deepEqual(
		calls
			.filter((call) => call.name === "day.flush.ack")
			.map((call) => (call.args as { generation: number }).generation),
		[10],
	);
	assert.equal(connection.connection(), opened);
	host.params.day.window = "changed";
	emit("day.changed");
	assert.equal(connection.connection().state, "none");
	assert.deepEqual(closed, ["day", "plans", "rituals", "update"]);
	emit("day.changed");
	emit("day.flush", { generation: 11 });
	assert.equal(closed.length, 4, "identity invalidation disposes each owner once");
});

test("synthetic large-session invalidation bursts and navigation resolution", async () => {
	reset();
	const { ConnectedToday } = await import(dayModule("todayFeed"));
	const { shown } = await import(dayModule("nav"));
	const { route } = await import(dayModule("view"));
	const feed = new ConnectedToday("window", today(5000));
	const places = { day: { today: () => feed.snapshot() } };
	function navigate() {
		for (let n = 0; n < 100000; n++) {
			route.set(n % 2 ? `mission-${n % 5000}` : null);
			assert.equal(shown(places), n % 2 ? "mission" : "today");
		}
	}
	navigate(); // Warm the identical navigation loop before measuring either tree.
	let answer!: (reply: unknown) => void;
	replies.set(
		"day.today.read",
		() =>
			new Promise((resolve) => {
				answer = resolve;
			}),
	);
	const start = performance.now();
	const cpu = process.cpuUsage();
	let published = 0;
	feed.onChange(() => {
		published++;
	});
	const reading = feed.refresh();
	for (let n = 0; n < 10000; n++) void feed.refresh();
	assert.equal(count("day.today.read"), 1);
	answer(ok(today(5000)));
	await settle();
	assert.equal(count("day.today.read"), 2, "one catch-up read, not one per event");
	// A newer read: one equal to what shows publishes nothing ("Live data in the UI").
	answer(ok({ ...today(5000), revision: 2 }));
	await reading;
	assert.equal(published, 1, "invalidated reply never publishes");
	navigate();
	route.set(null);
	feed.dispose();
	const usage = process.cpuUsage(cpu);
	console.log(
		JSON.stringify({
			synthetic: "day",
			ms: performance.now() - start,
			cpuMs: (usage.user + usage.system) / 1000,
			rssMiB: process.memoryUsage().rss / 1024 / 1024,
			hostReads: count("day.today.read"),
			published,
		}),
	);
});

test("disposed adapters stop queued refreshes and planning lag timers", async () => {
	reset();
	const { ConnectedToday } = await import(dayModule("todayFeed"));
	const { ConnectedPlans } = await import(dayModule("planFeed"));
	for (const [source, method] of [
		[new ConnectedToday("window", today()), "day.today.read"],
		[new ConnectedPlans("window", null), "day.plan.inventorySnapshot"],
	]) {
		let answer!: (reply: unknown) => void;
		replies.set(
			method,
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		let publications = 0;
		source.onChange(() => publications++);
		const reading = source.refresh();
		void source.refresh();
		source.dispose();
		answer(ok(method === "day.today.read" ? today() : { availability: "live", plans: [] }));
		await reading;
		await source.refresh();
		assert.equal(count(method), 1, "no catch-up after disposal");
		assert.equal(publications, 0);
	}
	const plans = new ConnectedPlans("window", null);
	replies.set("day.plan.read", () => ok({ missionId: "mission", fresh: false, note: "", interview: null }));
	await plans.open("mission");
	plans.page("mission");
	assert.equal(timers.size, 1);
	plans.dispose();
	assert.equal(timers.size, 0, "closing cancels the stale-page timer");
});

test("navigation precedence respects capabilities and home keeps drafts", async () => {
	reset();
	const { shown, backTarget, goHome } = await import(dayModule("nav"));
	const { route } = await import(dayModule("view"));
	const { planRoute, goalDraft } = await import(dayModule("planView"));
	const { settingsOpen } = await import(dayModule("preferencesView"));
	const { feedbackOpen } = await import(dayModule("feedbackView"));
	const { updateEntry, updateOpen } = await import(dayModule("updateView"));
	const { ritualRoute } = await import(dayModule("ritualView"));
	const { startFresh } = await import(dayModule("windowState"));
	startFresh();
	const places: { day: Record<string, unknown>; plans: object } = {
		day: { today, feed: { mission: () => null } },
		plans: {},
	};
	route.set("mission");
	planRoute.set({ kind: "plan", missionId: "mission" });
	settingsOpen.set(true);
	feedbackOpen.set(true);
	assert.equal(shown(places), "plan", "unsupported overlays never hide the underlying place");
	places.day.feedback = {};
	assert.equal(shown(places), "feedback");
	assert.equal(backTarget(places).label, "Mission overview");
	places.day.preferences = {};
	assert.equal(shown(places), "settings");
	ritualRoute.set({ kind: "end" });
	assert.equal(shown(places), "ritual");
	updateEntry.set({});
	updateOpen.set(true);
	assert.equal(shown(places), "update");
	backTarget(places).go();
	assert.equal(shown(places), "ritual", "Back reveals the covered screen");
	goalDraft.set("Exact 👩🏽‍💻  words\nkept");
	goHome();
	assert.equal(shown(places), "today");
	assert.equal(goalDraft(), "Exact 👩🏽‍💻  words\nkept");
	startFresh();
});

test("saved-window extraction preserves exact draft round trips and refusal", async () => {
	reset();
	const state = await import(dayModule("windowState"));
	const { planRoute, goalDraft } = await import(dayModule("planView"));
	const { reports } = await import(dayModule("view"));
	state.startFresh();
	planRoute.set({ kind: "new" });
	goalDraft.set("Exact 👩🏽‍💻  words\nkept");
	const saved = state.captureView();
	state.startFresh();
	state.restoreView(saved);
	assert.deepEqual(state.captureView(), saved);
	assert.equal(calls.length, 0, "restore does not send intent");
	reports.set({ action: "Exact report" });
	const attempts: { revision: number }[] = [];
	const result = await state.saveForms({
		today: () => ({ decisions: [], actions: [{ id: "action", title: "Check", revision: 7 }] }),
		feed: {
			saveDraft(intent: { revision: number }) {
				attempts.push(intent);
				return { status: "rejected", message: "refused" };
			},
			flushDrafts() {},
		},
	});
	assert.equal(result.saved, false);
	assert.equal(reports().action, "Exact report");
	assert.equal(attempts[0].revision, 7);
	state.startFresh();
});

test("planning-list animation belongs to the visible surface, not its data mirror", async () => {
	reset();
	const { mirrorPlanning } = await import(dayModule("planning"));
	const { animatePlanningList } = await import(dayModule("nav"));
	type ListRead = { availability: string; plans: { missionId: string; stage: string }[]; revision?: number };
	const listeners = new Set<(next: ListRead) => void>();
	const feed = {
		snapshot: () => ({ availability: "live", plans: [] }),
		onChange(listener: (next: ListRead) => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		dispose() {},
	};
	const plans = mirrorPlanning(feed, { close() {} });
	const publish = (n: number) => {
		for (const listener of listeners)
			listener({ availability: "live", plans: [{ missionId: `mission-${n}`, stage: "questions" }] });
	};
	publish(0);
	assert.equal(glides, 0, "data mirroring does not request UI animation");
	let at = "today";
	const stop = animatePlanningList(plans, () => at);
	publish(1);
	assert.equal(glides, 1);
	for (const destination of [
		"settings",
		"chat",
		"feedback",
		"delivery",
		"linear",
		"artifacts",
		"change",
		"changes",
		"new",
		"plan",
		"thread",
		"mission",
		"ritual",
		"update",
	]) {
		at = destination;
		publish(glides + destination.length);
		assert.equal(glides, 1, `hidden Today must not animate under ${destination}`);
	}
	at = "today";
	const current = plans.planning();
	for (const listener of listeners) listener({ ...current, revision: 99 });
	assert.equal(glides, 1, "revision-only publication does not move the list");
	publish(100);
	assert.equal(glides, 2);
	stop();
	publish(101);
	assert.equal(glides, 2, "surface disposal stops animation requests");
	plans.close();
	assert.equal(listeners.size, 0);
});

test("synthetic planning stream preserves visible-list animation and mirror cost", async () => {
	reset();
	const state = await import(dayModule("windowState"));
	state.startFresh();
	const { mirrorPlanning } = await import(dayModule("planning"));
	const navigation = await import(dayModule("nav"));
	type Read = { availability: string; plans: { missionId: string; stage: string }[] };
	const rows = Array.from({ length: 1000 }, (_, n) => ({ missionId: `mission-${n}`, stage: "questions" }));
	const first = { availability: "live", plans: rows };
	const second = { availability: "live", plans: rows.map((r, n) => (n === 0 ? { ...r, stage: "agreement" } : r)) };
	const listeners = new Set<(read: Read) => void>();
	const plans = mirrorPlanning(
		{
			snapshot: () => first,
			onChange(listener: (read: Read) => void) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			dispose() {},
		},
		{ close() {} },
	);
	// The baseline animates inside its mirror; the new surface owns that subscription.
	const stop = navigation.animatePlanningList?.(plans, () => "today") ?? (() => {});
	function stream() {
		for (let n = 0; n < 200; n++) for (const listener of listeners) listener(n % 2 ? first : second);
	}
	stream();
	glides = 0;
	const start = performance.now();
	const cpu = process.cpuUsage();
	stream();
	const usage = process.cpuUsage(cpu);
	assert.equal(glides, 200);
	assert.equal(plans.planning(), first);
	console.log(
		JSON.stringify({
			synthetic: "planning",
			ms: performance.now() - start,
			cpuMs: (usage.user + usage.system) / 1000,
			rssMiB: process.memoryUsage().rss / 1024 / 1024,
			publications: 200,
			glides,
		}),
	);
	stop();
	plans.close();
});

test("feature-owned persistence round-trips disclosures, notes, feedback and field selection", async () => {
	reset();
	const state = await import(dayModule("windowState"));
	const kept = await import(dayModule("kept"));
	state.startFresh();
	const words = "Exact 👩🏽‍💻  words\nkept";
	const saved = {
		...state.captureView(),
		place: "mission",
		id: "mission",
		goal: words,
		focused: "decision",
		help: ["decision/ask", "decision/details"],
		questions: ["attention/scope/round/question"],
		seeAll: ["attention/scope/round"],
		ritual: "start",
		date: "2026-11-16",
		step: 2,
		delivery: "chat/project/session",
		notes: [`chat/project/session\n${words}`],
		reminders: [`chat/project/session#${"a".repeat(64)}\nreport`],
		feedbackOpen: true,
		feedback: `mission/mission\n${words}`,
		feedbackImages: "[]",
		feedbackDrafts: [JSON.stringify({ text: words, origin: null })],
		feedbackProject: "project",
		feedbackAnswers: [`session/question\n1,2\n${words}`],
		feedbackLater: ["feedback/item"],
		thread: "mission/topic",
		threads: [`mission\ntopic\n${words}`],
		todayY: 42,
		todayRow: "mission-row",
		todayProject: "project",
		y: 18,
		input: "question",
		start: 2,
		end: 7,
	};
	state.restoreView(saved, undefined, { date: saved.date });
	const key = state.shownKey();
	assert.equal(key, "ritual");
	const scroll = kept.keepScroll(key);
	assert.equal(scroll.contentOffset.y, 18);
	const selected: unknown[] = [];
	kept
		.keepField(
			"question",
			() => key,
			() => words,
		)
		.ref({
			focus() {},
			setSelection(start: number, end: number) {
				selected.push([start, end]);
			},
		});
	assert.deepEqual(selected, [[2, 7]]);
	assert.deepEqual(state.captureView({ date: saved.date }), saved);
	assert.equal(calls.length, 0, "restoring all feature groups sends no intent");
	state.startFresh();
});
