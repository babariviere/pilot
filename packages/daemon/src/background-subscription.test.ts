import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BackgroundSubscription } from "./background-subscription.ts";
import type { SubscriptionProvider, SubscriptionUsageReading } from "./subscription-usage.ts";

test("fresh 99% holds background work, unknown snapshots preserve it, explicit Continue and reset affect only their provider", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "background-subscription-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	t.mock.timers.enable({ apis: ["Date"], now: 1000 });
	const readings: Record<SubscriptionProvider, SubscriptionUsageReading> = {
		anthropic: {
			status: "current",
			fetchedAt: 1000,
			windows: [{ label: "Week", usedPercent: 99, resetsAt: new Date(2000).toISOString() }],
		},
		openai: { status: "current", fetchedAt: 1000, windows: [{ label: "Week", usedPercent: 99, resetsAt: null }] },
	};
	let gate = new BackgroundSubscription(home, () => readings);
	await assert.rejects(gate.assert("anthropic"), /subscription hold/);
	await assert.rejects(gate.assert("openai-codex"), /subscription hold/);
	readings.anthropic = { status: "unknown", windows: [] };
	gate = new BackgroundSubscription(home, () => readings);
	await assert.rejects(gate.assert("anthropic"), /subscription hold/);
	await gate.continueAnyway("anthropic", await gate.read());
	await gate.assert("anthropic");
	await assert.rejects(gate.assert("openai-codex"), /subscription hold/);
	const shown = await gate.read();
	t.mock.timers.tick(1);
	readings.openai = {
		status: "current",
		fetchedAt: Date.now(),
		windows: [{ label: "New window", usedPercent: 99, resetsAt: null }],
	};
	await assert.rejects(gate.continueAnyway("openai", shown), /hold changed/);
	await assert.rejects(gate.assert("openai-codex"), /subscription hold/);
	t.mock.timers.tick(1000);
	await gate.assert("anthropic");
	assert.deepEqual(
		(await gate.read()).windows.map((w) => w.provider),
		["openai"],
	);
	await assert.rejects(gate.assert("openai-codex"), /subscription hold/);
	await gate.close();
});
