import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { KernelCommand } from "@pilot/kernel";
import { ProjectStore } from "./projects.ts";
import { SessionManager } from "./sessions.ts";
import { SubscriptionUsageCache } from "./subscription-usage.ts";
import { offlineSessionOptions } from "./testing/offline-session-options.ts";
import { UsageHistoryStore } from "./usage-history.ts";

for (const [offline, workerUsageHistory] of [
	[false, true],
	[true, false],
	[true, true],
] as const) {
	test(`custom workers keep independent services (offline=${offline}, worker history=${workerUsageHistory})`, {
		timeout: 5_000,
	}, async (t) => {
		const home = await mkdtemp(join(tmpdir(), "pilot-session-services-"));
		const projects = new ProjectStore(home);
		await projects.load();
		const subscription = t.mock.method(SubscriptionUsageCache.prototype, "start", async () => {});
		const usageHistory = new UsageHistoryStore(home);
		const status = await usageHistory.status();
		const history = t.mock.method(usageHistory, "status", async () => status);
		let opened!: (spec: Extract<KernelCommand, { type: "start" }>["spec"]) => void;
		const ready = new Promise<Extract<KernelCommand, { type: "start" }>["spec"]>((resolve) => {
			opened = resolve;
		});
		const sessions = new SessionManager(
			home,
			projects,
			home,
			{
				title: async () => undefined,
				worker: (spec, receive) => {
					opened(spec);
					queueMicrotask(() => receive({ type: "ready", model: "fake/model", working: false, usage: {} }));
					return {
						ready: Promise.resolve(),
						state: "idle",
						send() {},
						request: async () => {},
						close: async () => {},
					};
				},
			},
			{},
			offline
				? offlineSessionOptions({ usageHistory, ...(workerUsageHistory ? { workerUsageHistory } : {}) })
				: { usageHistory },
		);
		t.after(async () => {
			await sessions.shutdown();
			await rm(home, { recursive: true, force: true });
		});
		await sessions.load();
		assert.equal(subscription.mock.callCount(), offline ? 0 : 1);
		await sessions.spawn({
			cwd: home,
			title: "Synthetic",
			message: "Check independent services",
			model: "fake/model",
		});
		const spec = await ready;
		assert.deepEqual(
			spec.usageHistory,
			workerUsageHistory
				? {
						generation: status.generation,
						captureFloor: status.captureFloor,
						retentionFloor: status.retentionFloor,
					}
				: undefined,
		);
		assert.equal(history.mock.callCount(), workerUsageHistory ? 1 : 0);
	});
}
