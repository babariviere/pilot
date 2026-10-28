// biome-ignore-all lint/complexity/useLiteralKeys: Exercise registry seams without launching a kernel.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { KernelCommand, KernelPacket, KernelUsage } from "@pilot/kernel";
import type { SessionState, SessionSummary } from "@pilot/protocol";
import { ProjectStore } from "./projects.ts";
import { SessionManager, type SessionWorker } from "./sessions.ts";
import { type SubscriptionProvider, SubscriptionUsageCache } from "./subscription-usage.ts";

class FakeWorker implements SessionWorker {
	ready = Promise.resolve();
	state: SessionState = "idle";
	busy = false;
	usage?: KernelUsage;
	constructor(usage: KernelUsage) {
		this.usage = usage;
	}
	send(): void {}
	async request(): Promise<void> {}
	async close(): Promise<void> {}
}

async function writeUsageCache(agentDir: string, provider: SubscriptionProvider, entry: unknown): Promise<void> {
	const dir = join(agentDir, "cache", "usage-status", provider);
	await mkdir(dir, { recursive: true });
	const temp = join(dir, `cache.json.${randomUUID()}.tmp`);
	await writeFile(temp, JSON.stringify(entry));
	await rename(temp, join(dir, "cache.json"));
}

const claude = { fetchedAt: 10, snapshot: { provider: "anthropic", windows: [{ label: "5h", usedPercent: 40 }] } };
const codex = { fetchedAt: 20, snapshot: { provider: "openai", windows: [{ label: "Week", usedPercent: 7 }] } };

async function fixture(t: TestContext, models: Record<string, string>) {
	const home = await mkdtemp(join(tmpdir(), "pilot-session-usage-"));
	const agentDir = join(home, "agent");
	await writeUsageCache(agentDir, "anthropic", claude);
	await writeUsageCache(agentDir, "openai", codex);
	const ids: Record<string, string> = {};
	for (const [name, model] of Object.entries(models)) {
		const id = randomUUID();
		ids[name] = id;
		await mkdir(join(home, "sessions", id), { recursive: true });
		await writeFile(
			join(home, "sessions", id, "meta.json"),
			JSON.stringify({ id, cwd: home, title: name, createdAt: 100, updatedAt: 200, model }),
		);
	}
	let cache!: SubscriptionUsageCache;
	const workerUsage = new Map<string, KernelUsage>();
	const sessions = new SessionManager(
		home,
		new ProjectStore(home),
		agentDir,
		{
			worker: (spec, onPacket: (packet: KernelPacket) => void) => {
				const usage = workerUsage.get(spec.sessionId) ?? {};
				queueMicrotask(() => onPacket({ type: "ready", model: spec.model ?? "", working: false, usage }));
				return new FakeWorker(usage);
			},
		},
		{},
		{
			subscriptionUsage: (onChange) => {
				cache = new SubscriptionUsageCache(onChange, { agentDir, intervalMs: 60_000 });
				return cache;
			},
		},
	);
	await sessions.load();
	// node:test runs after-hooks in registration order, so managers reopened by a test register here and
	// are shut down before the home directory is removed. Otherwise their late writes race the removal.
	const managers = [sessions];
	t.after(async () => {
		for (const manager of managers) {
			await manager.shutdown();
			await Promise.allSettled(manager["saving"].values());
		}
		await rm(home, { recursive: true, force: true });
	});
	const adopt = (manager: SessionManager) => managers.push(manager);
	return { home, agentDir, ids, sessions, cache: () => cache, workerUsage, adopt };
}

test("parked sessions share their provider's subscription usage without a kernel", async (t) => {
	const f = await fixture(t, {
		claude: "anthropic/claude-sonnet",
		other: "anthropic/claude-opus",
		codex: "openai-codex/gpt-5",
		api: "openai/gpt-5",
	});
	const claudeUsage = { fetchedAt: 10, provider: "anthropic", windows: claude.snapshot.windows };
	assert.equal(f.sessions.get(f.ids.claude!)?.state, "parked");
	assert.deepEqual(f.sessions.get(f.ids.claude!)?.usage, { subscription: claudeUsage });
	assert.deepEqual(f.sessions.get(f.ids.other!)?.usage, { subscription: claudeUsage });
	assert.deepEqual(f.sessions.get(f.ids.codex!)?.usage?.subscription?.windows, codex.snapshot.windows);
	assert.equal(f.sessions.get(f.ids.api!)?.usage, undefined, "API-key models have no subscription windows");

	const changes: SessionSummary[] = [];
	f.sessions.onChange((summary) => changes.push(summary));
	await writeUsageCache(f.agentDir, "anthropic", { ...claude, fetchedAt: 11 });
	await f.cache().refresh();
	assert.deepEqual(changes.map((summary) => summary.title).sort(), ["claude", "other"]);
	assert.ok(changes.every((summary) => summary.usage?.subscription?.fetchedAt === 11));
});

test("live kernels contribute context and their physical provider for virtual models", async (t) => {
	const f = await fixture(t, { routed: "router/auto" });
	assert.equal(f.sessions.get(f.ids.routed!)?.usage, undefined, "a virtual model has no provider until it routes");
	const context = { tokens: 5, contextWindow: 100, percent: 5 };
	f.workerUsage.set(f.ids.routed!, { context, provider: "openai-codex" });
	await f.sessions["start"](f.ids.routed!);
	await f.sessions["workers"].get(f.ids.routed!)?.ready;
	assert.deepEqual(f.sessions.get(f.ids.routed!)?.usage, {
		context,
		subscription: { fetchedAt: 20, provider: "openai", windows: codex.snapshot.windows },
	});
});

test("a 95% reading holds durable work, not idle results, and force is chat/child scoped", async (t) => {
	const f = await fixture(t, { first: "openai-codex/gpt-5", second: "openai-codex/gpt-5" });
	const first = f.ids.first!,
		second = f.ids.second!;
	await f.sessions["start"](first);
	await f.sessions["start"](second);
	const worker = f.sessions["workers"].get(first)!;
	worker.state = "working";
	f.sessions["metas"].get(first)!.working = true;
	const completed = f.sessions["metas"].get(second)!;
	completed.outcome = "done";
	completed.outcomeAt = 100;
	const fetchedAt = Date.now();
	await writeUsageCache(f.agentDir, "openai", {
		fetchedAt,
		snapshot: { windows: [{ label: "5h", usedPercent: 95, resetsAt: new Date(fetchedAt + 60_000).toISOString() }] },
	});
	await f.cache().refresh();
	await f.sessions["subscriptionPolicyWrites"];
	assert.equal(f.sessions.get(first)?.working, false);
	assert.equal(f.sessions.get(first)?.state, "working", "the kernel still owns a recoverable durable run");
	assert.equal(f.sessions.get(first)?.outcome, undefined);
	assert.equal(f.sessions.get(second)?.outcome, "done", "an unrelated usage warning cannot hide a finished result");
	worker.toolsRunning = true;
	assert.equal(f.sessions.get(first)?.working, true, "the current call drains before showing the usage pause");
	worker.toolsRunning = false;
	assert.equal(f.sessions.get(first)?.working, false, "the pause takes effect as soon as the call finishes");
	const policyFile = (id: string) => join(f.home, "sessions", id, "subscription-policy.json");
	const blocked = JSON.parse(await readFile(policyFile(first), "utf8"));
	assert.equal(blocked.windows.length, 1);
	assert.deepEqual(blocked.forced, []);
	await f.sessions.forceSubscription(first, true);
	assert.equal(f.sessions.get(first)?.subscriptionPause?.forced, true);
	assert.equal(f.sessions.get(first)?.working, true);
	assert.equal(f.sessions.get(second)?.subscriptionPause?.forced, undefined);
	assert.equal(JSON.parse(await readFile(policyFile(first), "utf8")).forced.length, 1);
	assert.equal(JSON.parse(await readFile(policyFile(second), "utf8")).forced.length, 0);
	assert.equal(
		JSON.parse(await readFile(join(f.home, "sessions", first, "meta.json"), "utf8")).subscriptionPolicy.forced.length,
		1,
	);
	await f.sessions.forceSubscription(first, false);
	assert.equal(f.sessions.subscriptionPaused(first), true);
	await writeUsageCache(f.agentDir, "openai", {
		fetchedAt: Date.now() + 60_000,
		snapshot: { windows: [{ label: "5h", usedPercent: 10 }] },
	});
	// A future clock is not a fresh reading. Do not release on it.
	await f.cache().refresh();
	await f.sessions["subscriptionPolicyWrites"];
	assert.equal(f.sessions.subscriptionPaused(first), true);
	await writeUsageCache(f.agentDir, "openai", {
		fetchedAt: Date.now(),
		snapshot: { windows: [{ label: "5h", usedPercent: 10 }] },
	});
	await f.cache().refresh();
	await f.sessions["subscriptionPolicyWrites"];
	assert.equal(f.sessions.get(first)?.subscriptionPause, undefined);
	assert.equal(f.sessions.get(first)?.working, true);
});

test("a different-provider child cannot escape limits, and its parent exposes the warning", async (t) => {
	const f = await fixture(t, { parent: "anthropic/claude-sonnet" });
	const id = f.ids.parent!;
	await f.sessions["start"](id);
	f.sessions["metas"].get(id)!.subagents = [
		{
			name: "child",
			state: "working",
			task: "work",
			createdAt: 0,
			cwd: f.home,
			storage: join(f.home, "child"),
			model: "openai-codex/gpt-5",
		},
	];
	const fetchedAt = Date.now();
	await writeUsageCache(f.agentDir, "openai", {
		fetchedAt,
		snapshot: { windows: [{ label: "Week", usedPercent: 97 }] },
	});
	await f.cache().refresh();
	await f.sessions["subscriptionPolicyWrites"];
	assert.equal(f.sessions.get(id)?.subscriptionPause?.windows[0]?.provider, "openai");
	assert.equal(f.sessions.get(id)?.working, false, "only blocked child work remains");
	assert.equal(f.sessions.get(id)?.state, "working", "the paused child is not a completed chat");
	const policy = JSON.parse(await readFile(join(f.home, "sessions", id, "subscription-policy.json"), "utf8"));
	assert.equal(
		policy.windows[0].provider,
		"openai",
		"children inherit the full policy, not only the parent's provider",
	);
	await f.sessions.forceSubscription(id, true);
	assert.equal(f.sessions.get(id)?.working, true);
});

test("force work stays on when a fresh reading moves the reset time or adds a window", async (t) => {
	const f = await fixture(t, { chat: "openai-codex/gpt-5" });
	const id = f.ids.chat!;
	const fetchedAt = Date.now();
	await writeUsageCache(f.agentDir, "openai", {
		fetchedAt,
		snapshot: { windows: [{ label: "5h", usedPercent: 95, resetsAt: new Date(fetchedAt + 60_000).toISOString() }] },
	});
	await f.cache().refresh();
	await f.sessions.forceSubscription(id, true);
	await writeUsageCache(f.agentDir, "openai", {
		fetchedAt: fetchedAt + 1,
		snapshot: {
			windows: [
				{ label: "5h", usedPercent: 97, resetsAt: new Date(fetchedAt + 60_001).toISOString() },
				{ label: "Week", usedPercent: 96 },
			],
		},
	});
	await f.cache().refresh();
	await f.sessions["subscriptionPolicyWrites"];
	assert.equal(f.sessions.get(id)?.subscriptionPause?.windows.length, 2);
	assert.equal(f.sessions.get(id)?.subscriptionPause?.forced, true);
	const policy = JSON.parse(await readFile(join(f.home, "sessions", id, "subscription-policy.json"), "utf8"));
	assert.equal(policy.forced.length, 2, "the admission gate passes the moved and new windows");
});

test("the reset timer releases work and expires force without a new provider reading", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
	const f = await fixture(t, { chat: "openai-codex/gpt-5" });
	const id = f.ids.chat!;
	const reset = Date.now() + 60_000;
	await writeUsageCache(f.agentDir, "openai", {
		fetchedAt: Date.now(),
		snapshot: { windows: [{ label: "5h", usedPercent: 95, resetsAt: new Date(reset).toISOString() }] },
	});
	await f.cache().refresh();
	assert.ok(f.sessions.get(id)?.subscriptionPause);
	await f.sessions.forceSubscription(id, true);
	assert.equal(f.sessions.get(id)?.subscriptionPause?.forced, true);
	const policyFile = join(f.home, "sessions", id, "subscription-policy.json");
	const forcedPolicy = JSON.parse(await readFile(policyFile, "utf8"));
	assert.equal(forcedPolicy.windows.length, 1);
	assert.equal(forcedPolicy.forced.length, 1);
	// Summary notifications use the current clock; unrelated notifications can show the reset
	// before its policy write completes. Observe the notification and persistence separately.
	const resumed = new Promise<void>((resolve) =>
		f.sessions.onChange((summary) => {
			if (summary.id === id && !summary.subscriptionPause) resolve();
		}),
	);
	t.mock.timers.tick(59_999);
	assert.equal(f.sessions.get(id)?.subscriptionPause?.forced, true, "force lasts until the reset boundary");
	t.mock.timers.tick(1);
	// Exercise an unrelated update before asynchronous policy persistence can finish.
	f.sessions["emit"](f.sessions["metas"].get(id)!);
	await resumed;
	await f.sessions["subscriptionPolicyWrites"];
	assert.equal(f.sessions.get(id)?.subscriptionPause, undefined);
	const policy = JSON.parse(await readFile(policyFile, "utf8"));
	assert.deepEqual(policy.windows, []);
	assert.deepEqual(policy.forced, []);
});

test("a known pause and its per-chat force survive daemon restart when provider usage is unavailable", async (t) => {
	const f = await fixture(t, { chat: "openai-codex/gpt-5" });
	const id = f.ids.chat!;
	await writeUsageCache(f.agentDir, "openai", {
		fetchedAt: Date.now(),
		snapshot: { windows: [{ label: "Week", usedPercent: 97 }] },
	});
	await f.cache().refresh();
	await f.sessions.forceSubscription(id, true);
	await f.sessions.shutdown();
	const reopened = new SessionManager(
		f.home,
		new ProjectStore(f.home),
		f.agentDir,
		{
			worker: () => new FakeWorker({ provider: "openai-codex" }),
		},
		{},
		{
			subscriptionUsage: () => ({ get: () => undefined, start: async () => {}, close() {} }),
		},
	);
	f.adopt(reopened);
	await reopened.load();
	assert.equal(reopened.get(id)?.subscriptionPause?.forced, true);
	await reopened.forceSubscription(id, false);
	assert.equal(reopened.subscriptionPaused(id), true, "a missing provider reading cannot release the durable pause");
	await reopened["start"](id);
	const policy = JSON.parse(await readFile(join(f.home, "sessions", id, "subscription-policy.json"), "utf8"));
	assert.equal(policy.windows[0]?.usedPercent, 97);
	assert.deepEqual(policy.forced, []);
});

test("provider-reported limits acknowledge only a persisted resumable pause, and survive a daemon restart", async (t) => {
	const f = await fixture(t, { chat: "openai-codex/gpt-5" });
	const id = f.ids.chat!;
	await f.sessions["start"](id);
	const worker = f.sessions["workers"].get(id)!;
	worker.state = "working";
	const meta = f.sessions["metas"].get(id)!;
	meta.working = true;
	const ack = new Promise<KernelCommand>((resolve) =>
		t.mock.method(worker, "send", (command: KernelCommand) => {
			if (command.type === "subscription.limit.result") resolve(command);
		}),
	);
	f.sessions["onPacket"](meta, worker, { type: "subscription.limit", callId: "limit", limit: { provider: "openai" } });
	assert.deepEqual(await ack, { type: "subscription.limit.result", callId: "limit" });
	assert.equal(f.sessions.get(id)?.state, "working");
	assert.equal(f.sessions.get(id)?.working, false);
	assert.equal(f.sessions.get(id)?.outcome, undefined, "no failure or completion is synthesized");
	assert.equal(f.sessions.subscriptionPaused(id), true);
	const file = join(f.home, "sessions", id);
	const policy = JSON.parse(await readFile(join(file, "subscription-policy.json"), "utf8"));
	assert.equal(policy.windows[0].label, "Usage limit");
	assert.deepEqual(JSON.parse(await readFile(join(file, "meta.json"), "utf8")).subscriptionPolicy, policy);
	await f.sessions.forceSubscription(id, true);
	assert.equal(f.sessions.subscriptionPaused(id), false);
	await f.sessions.forceSubscription(id, false);
	await f.sessions.shutdown();
	const reopened = new SessionManager(
		f.home,
		new ProjectStore(f.home),
		f.agentDir,
		{ worker: () => new FakeWorker({ provider: "openai-codex" }) },
		{},
		{
			subscriptionUsage: () => ({ get: () => undefined, start: async () => {}, close() {} }),
		},
	);
	f.adopt(reopened);
	await reopened.load();
	assert.equal(reopened.subscriptionPaused(id), true);
	await Promise.allSettled(reopened["starting"].values());
});
