import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "@pilot/protocol";
import { githubRepository, lookupPullRequests } from "./github.ts";
import { pollLinear } from "./linear-source.ts";
import { createSlackPoller } from "./slack-source.ts";
import { cassetteRunner, cassetteSource, loadCassette } from "./testing/cassette.ts";
import { TrackedItemStore } from "./tracked-items.ts";

test("GitHub discovery replays an exact gh GraphQL request through the real parser", async (t) => {
	t.mock.method(globalThis, "fetch", () => assert.fail("service fixtures must remain offline"));
	const cassette = await loadCassette(new URL("./fixtures/cassettes/github-discovery.json", import.meta.url));
	const result = await lookupPullRequests(
		githubRepository("https://github.com/octo/repo"),
		{ heads: ["feat/example"] },
		"/unused",
		cassetteRunner(cassette),
	);
	assert.equal(result.heads.get("feat/example")?.number, 1);
	assert.equal(result.heads.get("feat/example")?.checks, "passing");
	cassette.assertDone();
});

test("Slack replay exercises channel history and thread parsing without any model calls", async (t) => {
	t.mock.method(globalThis, "fetch", () => assert.fail("service fixtures must remain offline"));
	const root = await mkdtemp(join(tmpdir(), "pilot-slack-cassette-"));
	const store = new TrackedItemStore(join(root, "tracked.sqlite"));
	t.after(async () => {
		await store.close();
		await rm(root, { recursive: true, force: true });
	});
	const cassette = await loadCassette(new URL("./fixtures/cassettes/slack-thread.json", import.meta.url));
	const poll = createSlackPoller(
		store,
		{
			classifySlack: async (_path, text) => ({
				type: text.includes("Export crashes") ? "bug" : "unknown",
				confidence: 0.9,
				severity: "high",
				summary: "Export crashes",
				label: null,
			}),
		},
		() => Date.UTC(2026, 9, 13, 12),
	);
	const result = await poll({
		project: { id: "p", path: root } as Project,
		config: { slackChannels: ["C000000001"] },
		signal: new AbortController().signal,
		call: cassetteSource(cassette),
	});
	assert.equal(result.items.length, 2);
	assert.equal(result.items[0]?.externalId, "C000000001/1791885305.000001");
	cassette.assertDone();
});

test("Linear replay checks scope, fields and both pagination passes through the real poller", async (t) => {
	t.mock.method(globalThis, "fetch", () => assert.fail("service fixtures must remain offline"));
	const cassette = await loadCassette(new URL("./fixtures/cassettes/linear-current.json", import.meta.url));
	const result = await pollLinear({
		project: { id: "p" } as Project,
		config: { linearTeam: "team-root", slackChannels: [] },
		signal: new AbortController().signal,
		call: cassetteSource(cassette),
	});
	assert.deepEqual(result.activeIds, ["issue-1", "issue-2"]);
	assert.equal(result.linear?.currentCycle?.progress, 0.5);
	assert.equal(result.items.length, 2);
	cassette.assertDone();
});
