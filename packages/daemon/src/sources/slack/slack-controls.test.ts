import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { DurableOperation } from "@pilot/protocol";
import { nativeIntakeFixture } from "../../day/intake/native-intake.fixture.ts";
import { payloadHash } from "../../transport/operations/operation-journal.ts";
import { safeSlackLink } from "./slack-controls.ts";
import { SlackImportRefused } from "./slack-tracking.ts";
import { SourceRateLimited, SourceSignInRequired, SourceToolError } from "../source-tool-rules.ts";

test("native Slack settings are passive, capability-gated and fenced; imports work with tracking off", async (t) => {
	const f = await nativeIntakeFixture();
	t.after(() => f.close());
	let imports = 0;
	f.setSlackAdder(async (_context, link) => {
		imports++;
		return {
			externalId: `${link.channel}/${link.threadTs}`,
			title: "Imported report",
			url: "https://example.slack.com/archives/COTHER/p1794843000000001",
			status: "open",
			metadata: { manual: true, channel: link.channel, threadTs: link.threadTs },
			updatedAt: Date.now(),
			slack: { type: "bug", label: null, severity: "medium", status: "open", overrides: {} },
		};
	});
	const headers = { "x-pilot-github-capability": f.capability, "content-type": "application/json" };
	const read = async () => {
		const r = await fetch(`${f.root}/api/slack-controls?projectId=${f.project.id}`, { headers });
		assert.equal(r.status, 200);
		assert.equal(r.headers.get("cache-control"), "no-store");
		return r.json();
	};
	const denied = await fetch(`${f.root}/api/slack-controls?projectId=${f.project.id}`);
	assert.equal(denied.status, 403);
	await denied.arrayBuffer();
	const first = await read();
	await read();
	assert.equal(imports, 0);
	assert.equal(f.stats().external, 0);
	assert.deepEqual(first.coverage, { startupDays: 7, replyOnlyMentions: "not_discovered", complete: false });
	const op = (binding: string, action: string, value: unknown): DurableOperation => {
		const payload = JSON.stringify({ purpose: "slack-controls", projectId: f.project.id, binding, action, value });
		return {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: randomUUID(),
			sequence: 1,
			origin: { ...f.host, hostId: "local" },
			destination: f.host,
			kind: "slack-controls",
			targetId: f.project.id,
			payload,
			payloadHash: payloadHash(payload),
			bindingId: binding,
			bindingGeneration: 1,
		};
	};
	const post = async (operation: DurableOperation, lookup = false) =>
		(
			await fetch(`${f.root}/api/operations${lookup ? "/receipt" : ""}`, {
				method: "POST",
				headers,
				body: JSON.stringify(operation),
			})
		).json();
	const save = op(first.binding, "save", { channels: ["C123"], mentionOnly: ["C123"], groups: ["support"] });
	assert.equal((await post(save)).state, "accepted");
	assert.deepEqual(f.projects.require(f.project.id).tracking?.slackChannels, ["C123"]);
	assert.equal(f.projects.require(f.project.id).tracking?.linearTeam, "FAKE", "Slack edits preserve Linear settings");
	assert.equal(
		(await post(op(first.binding, "save", { channels: [], mentionOnly: [], groups: [] }))).state,
		"rejected",
	);
	const fresh = await read();
	assert.equal(
		(await post(op(fresh.binding, "save", { channels: [], mentionOnly: [], groups: [] }))).state,
		"accepted",
	);
	const off = await read();
	const add = op(off.binding, "import", { url: "https://example.slack.com/archives/COTHER/p1794843000000001" });
	const receipt = await post(add);
	assert.equal(receipt.state, "accepted", JSON.stringify(receipt));
	assert.deepEqual(await post(add), receipt);
	assert.deepEqual(await post(add, true), receipt);
	assert.equal(imports, 1);
	assert.equal((await read()).source.configured, false);
	assert.equal(
		(await f.tracking.intakeSources(f.project.id))[0]!.total,
		1,
		"import remains in intake while tracking is off",
	);
});

test("Slack link journaling subset excludes credentials and unrelated parameters", () => {
	assert.equal(
		safeSlackLink("https://example.slack.com/archives/C123/p1794843000000001?thread_ts=1794843000.000001&cid=C123"),
		true,
	);
	for (const url of [
		"https://user:secret@example.slack.com/archives/C123/p1794843000000001",
		"https://example.slack.com/archives/C123/p1794843000000001?token=secret",
		"https://example.slack.com/archives/C123/p1794843000000001#secret",
	])
		assert.equal(safeSlackLink(url), false);
});

test("known pre-save import failures reject with a reason; persistence uncertainty stays pending without replay", async (t) => {
	const f = await nativeIntakeFixture();
	t.after(() => f.close());
	const headers = { "x-pilot-github-capability": f.capability, "content-type": "application/json" };
	const snapshot = await (await fetch(`${f.root}/api/slack-controls?projectId=${f.project.id}`, { headers })).json();
	const operation = () => {
		const payload = JSON.stringify({
			purpose: "slack-controls",
			projectId: f.project.id,
			binding: snapshot.binding,
			action: "import",
			value: { url: "https://example.slack.com/archives/COTHER/p1794843000000001" },
		});
		return {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: randomUUID(),
			sequence: 1,
			origin: { ...f.host, hostId: "local" },
			destination: f.host,
			kind: "slack-controls",
			targetId: f.project.id,
			payload,
			payloadHash: payloadHash(payload),
			bindingId: snapshot.binding,
			bindingGeneration: 1,
		};
	};
	const post = async (op: ReturnType<typeof operation>, lookup = false) =>
		(
			await fetch(`${f.root}/api/operations${lookup ? "/receipt" : ""}`, {
				method: "POST",
				headers,
				body: JSON.stringify(op),
			})
		).json();
	assert.equal((await post(operation())).state, "rejected", "missing connector is not Unknown");
	for (const error of [new SourceSignInRequired(), new SourceToolError("private remote payload", "access_denied")]) {
		f.setSlackAdder(async () => {
			throw error;
		});
		const r = await post(operation());
		assert.equal(r.state, "rejected");
		assert.match(r.reason, /Sign in|Couldn't read/);
		assert.doesNotMatch(r.reason, /private remote/);
	}
	let commits = 0;
	f.setSlackAdder(async () => ({
		externalId: "COTHER/1794843000.000001",
		title: "Saved import",
		url: "https://example.slack.com/archives/COTHER/p1794843000000001",
		status: "open",
		metadata: { manual: true, channel: "COTHER" },
		updatedAt: Date.now(),
	}));
	const commit = f.items.commit.bind(f.items);
	const mocked = t.mock.method(f.items, "commit", async (...args: Parameters<typeof commit>) => {
		commits++;
		await commit(...args);
		throw new SourceSignInRequired("simulated failure after commit");
	});
	const lost = operation(),
		pending = await post(lost);
	assert.equal(pending.state, "pending");
	assert.deepEqual(await post(lost, true), pending);
	assert.deepEqual(await post(lost), pending);
	assert.equal(commits, 1);
	mocked.mock.restore();
	f.setSlackAdder(async () => {
		throw new SourceRateLimited(60_000);
	});
	assert.equal((await post(operation())).state, "rejected");
	assert.equal(
		(await post(operation())).state,
		"rejected",
		"active provider delay is a definite refusal, not Unknown",
	);
	const legacy = () =>
		fetch(`${f.root}/api/tracking/slack/messages`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				projectId: f.project.id,
				url: "https://example.slack.com/archives/COTHER/p1794843000000001",
			}),
		});
	const refused = t.mock.method(f.tracking.slack, "add", async () => {
		throw new SlackImportRefused("Sign in to Slack to add this message");
	});
	const known = await legacy();
	assert.equal(known.status, 503);
	await known.arrayBuffer();
	refused.mock.restore();
	t.mock.method(f.tracking.slack, "add", async () => {
		throw new Error("private provider payload");
	});
	const unknown = await legacy();
	assert.equal(unknown.status, 500);
	assert.doesNotMatch(await unknown.text(), /private provider/);
});
