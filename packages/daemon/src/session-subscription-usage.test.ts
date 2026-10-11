// biome-ignore-all lint/complexity/useLiteralKeys: Exercise registry seams without launching a kernel.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { KernelPacket, KernelUsage } from "@pilot/kernel";
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
	t.after(async () => {
		await sessions.shutdown();
		await Promise.allSettled(sessions["saving"].values());
		await rm(home, { recursive: true, force: true });
	});
	return { agentDir, ids, sessions, cache: () => cache, workerUsage };
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
