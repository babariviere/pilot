import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { Project, TrackingJson } from "@pilot/protocol";
import { ProjectStore, validateTrackingConfig } from "./projects.ts";
import { slackThreadFixture } from "./slack-fixtures.ts";
import { SlackFormatChanged } from "./slack-format.ts";
import { dominantSlackGroup, mentionsMe, parseSlackIdentity, parseSlackMentions } from "./slack-mentions.ts";
import { createSlackPoller } from "./slack-source.ts";
import { dedicatedSourceTool, SourceToolError, validSourceArguments } from "./source-mcp.ts";
import { type SourcePollContext, SourceRegistry } from "./sources.ts";
import { TrackedItemStore } from "./tracked-items.ts";
import { SLACK_HOURLY_BUDGET } from "./tracked-items-disk.ts";

const now = Date.UTC(2026, 9, 13, 12);
const channel = "C000000001";
const parent = "1791885305.000001";
const reply = "1791885480.000001";
const profile = { result: "User ID: U000000099\nUsername: fixture.user\nEmail: invented@example.test\n" };
const bug = {
	type: "bug" as const,
	confidence: 0.99,
	severity: "high" as const,
	summary: "Export crashes",
	label: null,
};
const end = "End of results - No more pages available.\\n";
const historyEnd = "There are no more messages available.\n";
/** Channel history in the dedicated server's format. replies adds the Thread line that triggers a thread read. */
function history(messages: Array<{ ts: string; text: string; replies?: number }>, next?: string) {
	return {
		messages: `Channel: #bugs (${channel})\n\n${messages
			.map(
				(message) =>
					`=== Message from Reporter (U000000001) at 2026-10-13 11:55:05 CEST === \nMessage TS: ${message.ts}\n\n${message.text}\n${message.replies ? `Thread: ${message.replies} replies (latest: 2026-10-13 12:00:00 CEST)\n` : ""}`,
			)
			.join("\n")}`,
		pagination_info: next
			? `There are more messages available. To view the next page, use cursor: \`${next}\`\n`
			: historyEnd,
	};
}
/** Several search results, one per text, each in the configured channel. */
function searchMany(texts: string[]) {
	return {
		results: `# Search Results for: \n\n## Messages (${texts.length} results)\n${texts
			.map((text, n) => {
				const ts = `17918853${String(n).padStart(2, "0")}.000001`;
				return `### Result ${n + 1} of ${texts.length}\nChannel: #bugs (ID: ${channel})\nFrom: Reporter\nTime: 2026-10-13\nMessage_ts: ${ts}\nPermalink: https://example.slack.com/archives/${channel}/p${ts.replace(".", "")}\nText: ${text}\n`;
			})
			.join("")}`,
		pagination_info: end,
	};
}
function search(body?: string, options: { channel?: string; ts?: string; parent?: string; next?: string } = {}) {
	const id = options.channel ?? channel;
	const ts = options.ts ?? parent;
	const thread = options.parent;
	return {
		results: `# Search Results for: \n\n${
			body === undefined
				? "No results found.\n"
				: `## Messages (1 result)\n### Result 1 of 1\nChannel: #bugs (ID: ${id})\nFrom: Reporter\nTime: 2026-10-13\nMessage_ts: ${ts}\nPermalink: https://example.slack.com/archives/${id}/p${ts.replace(".", "")}${thread ? `?thread_ts=${thread}&cid=${id}` : ""}\nText: ${body}\n`
		}`,
		pagination_info: options.next ? `For the next page of results use cursor \`${options.next}\`` : end,
	};
}
async function fixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "slack-mentions-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const store = new TrackedItemStore(join(home, "tracked.sqlite"));
	t.after(() => store.close());
	const project: Project = {
		id: "p1",
		name: "App",
		path: home,
		createdAt: 0,
		tracking: { slackChannels: [channel], slackMentionOnlyChannels: [channel] },
	};
	const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
	const texts: string[] = [];
	let response: TrackingJson | Error = search();
	let page: TrackingJson = history([]);
	let clock = now;
	const poll = createSlackPoller(
		store,
		{
			classifySlack: async (_path, text) => {
				texts.push(text);
				return bug;
			},
		},
		() => clock,
	);
	const context: SourcePollContext = {
		project,
		config: project.tracking!,
		signal: new AbortController().signal,
		call: async (tool, args) => {
			calls.push({ tool, args });
			if (tool === "profile") {
				assert.deepEqual(args, { response_format: "detailed" });
				return profile;
			}
			if (tool === "history") return page;
			if (tool === "mentionsPrivate") {
				assert.ok(validSourceArguments(tool, args));
				if (response instanceof Error) throw response;
				return response;
			}
			if (tool === "thread") {
				assert.equal(args.channel_id, channel);
				assert.equal(args.message_ts, parent);
				return slackThreadFixture;
			}
			assert.fail(`Unexpected tool ${tool}`);
		},
	};
	return {
		home,
		store,
		project,
		poll,
		context,
		calls,
		texts,
		set: (value: TrackingJson | Error) => {
			response = value;
		},
		history: (value: TrackingJson) => {
			page = value;
		},
		tick: (ms = 300_000) => {
			clock += ms;
		},
	};
}

test("config validates and normalizes per-channel opt-in and explicit project group handles", () => {
	assert.deepEqual(
		validateTrackingConfig({
			slackChannels: [" C1 ", "C2"],
			slackMentionOnlyChannels: ["C1", "C1"],
			slackGroupHandles: ["@OnCall", "oncall", " client-team "],
		}),
		{
			slackChannels: ["C1", "C2"],
			slackMentionOnlyChannels: ["C1"],
			slackGroupHandles: ["oncall", "client-team"],
		},
	);
	assert.deepEqual(validateTrackingConfig({ slackChannels: ["C1"] }), { slackChannels: ["C1"] });
	for (const slackMentionOnlyChannels of [["C2"], [1], "C1", Array(101).fill("C1")])
		assert.throws(
			() => validateTrackingConfig({ slackChannels: ["C1"], slackMentionOnlyChannels }),
			/slackMentionOnlyChannels/,
		);
	for (const slackGroupHandles of [
		["@here"],
		["channel"],
		["EVERYONE"],
		[1],
		["@two words"],
		Array(31).fill("oncall"),
	])
		assert.throws(() => validateTrackingConfig({ slackChannels: ["C1"], slackGroupHandles }), /slackGroupHandles/);
	assert.equal(dedicatedSourceTool("slack", "profile"), "slack_read_user_profile");
	assert.equal(dedicatedSourceTool("slack", "mentions"), undefined);
	assert.equal(dedicatedSourceTool("slack", "mentionsPrivate"), "slack_search_public_and_private");
	assert.equal(
		validSourceArguments("mentionsPrivate", { filters: "in:<#C1>", channel_types: "public_channel,private_channel" }),
		true,
	);
	for (const filters of [undefined, "", "in:<#C1> OR in:<#C2>", "with:<@U1>", "in:<#C1> in:<#C2>"])
		assert.equal(
			validSourceArguments("mentionsPrivate", { filters, channel_types: "public_channel,private_channel" }),
			false,
		);
	assert.equal(validSourceArguments("mentionsPrivate", { filters: "in:<#C1>" }), false);
	assert.equal(dedicatedSourceTool("slack", "search_private"), undefined);
});

test("identity parsing retains no profile details; direct and group mentions exclude broadcasts and prefixes", () => {
	const me = parseSlackIdentity(profile);
	assert.deepEqual(me, { id: "U000000099", username: "fixture.user" });
	for (const text of [
		"Hi <@U000000099>",
		"<@U000000099|Someone>",
		"Hi @fixture.user!",
		"<!subteam^S00001|@oncall>",
		"@oncall please",
	])
		assert.equal(mentionsMe(text, me, ["oncall"]), true, text);
	for (const text of [
		"<@U0000000999>",
		"<@U000000001>",
		"@fixture.user-other",
		"@oncall-other",
		"@other-group",
		"<!here>",
		"<!channel>",
		"<!everyone>",
		"@here @channel @everyone",
		"email@oncall.test",
	])
		assert.equal(mentionsMe(text, me, ["oncall"]), false, text);
	assert.throws(() => parseSlackIdentity({ result: "Username: someone" }), SlackFormatChanged);
});

test("strict search framing resolves reply parents and rejects other channels and malformed permalinks", () => {
	assert.equal(
		parseSlackMentions(search("<@U000000099>", { ts: reply, parent }), channel, "bugs", 8).messages[0]?.threadTs,
		parent,
	);
	assert.equal(parseSlackMentions(search(), channel, "bugs", 8).messages.length, 0);
	for (const value of [
		search("<@U000000099>", { channel: "COTHER" }),
		search("x", { parent: "bad" }),
		{ ...search("x"), pagination_info: "unknown" },
		{ ...search("x"), results: search("x").results.replace("example.slack.com", "example.test") },
	])
		assert.throws(() => parseSlackMentions(value, channel, "bugs", 8), SlackFormatChanged);
});

test("search accepts the newer reply-count line, Markdown permalinks and result separators", () => {
	const permalink = `https://example.slack.com/archives/${channel}/p${reply.replace(".", "")}?thread_ts=${parent}&cid=${channel}`;
	const result = (link: string) => ({
		results: `# Search Results for: \n\n## Messages (1 result)\n### Result 1 of 1\nChannel: #bugs (ID: ${channel})\nFrom: Reporter <r@example.test> (ID: U000000001) \nTime: 2026-10-13 12:00:00 CEST\nMessage_ts: ${reply}\nReply count: 5\nPermalink: ${link}\nText: \n<@U000000099> export crashes\n\n---\n\n`,
		pagination_info: end,
	});
	const page = parseSlackMentions(result(`[link](${permalink})`), channel, "bugs", 8);
	assert.deepEqual(page.messages, [{ ts: reply, threadTs: parent, text: "<@U000000099> export crashes", replies: 0 }]);
	assert.equal(parseSlackMentions(result(permalink), channel, "bugs", 8).messages[0]?.threadTs, parent);
	for (const link of [
		`[link](${permalink.replace("example.slack.com", "example.test")})`,
		`[link](${permalink}`,
		`[link](${permalink}) extra`,
	])
		assert.throws(() => parseSlackMentions(result(link), channel, "bugs", 8), SlackFormatChanged);
});

test("dominant group IDs need two results and a clear lead", () => {
	const page = (texts: string[]) => ({
		channel,
		name: "bugs",
		messages: texts.map((text, n) => ({ ts: `${n}.000001`, threadTs: `${n}.000001`, text, replies: 0 })),
	});
	assert.equal(
		dominantSlackGroup(
			page(["Groups: <@S0A1><@S0B2> <@S0C3>", "<@S0B2> hi", "Hello <!subteam^S0B2>", "<@S0B2> <@S0B2>"]),
		),
		"S0B2",
	);
	assert.equal(dominantSlackGroup(page(["<@S0B2> hi"])), null, "one result is not enough");
	assert.equal(dominantSlackGroup(page(["<@S0A1>", "<@S0B2>", "<@S0A1> <@S0B2>"])), null, "a tie is ambiguous");
	assert.equal(dominantSlackGroup(page(["<@U000000099>", "<@U000000099>"])), null, "users are not groups");
});

test("mention-only channels read history, keep only messages that mention me and never search for them", async (t) => {
	const f = await fixture(t);
	f.history(
		history([
			{ ts: parent, text: "<@U000000099|Fixture User> please investigate", replies: 2 },
			{ ts: "1791885000.000001", text: "<!here> <!channel> @other-group <@U000000001>" },
		]),
	);
	const first = await f.poll(f.context);
	assert.deepEqual(
		first.items.map((item) => item.externalId),
		[`${channel}/${parent}`],
	);
	assert.match(f.texts[0]!, /Export crashes[\s\S]*TypeError[\s\S]*Small files work/);
	assert.deepEqual(
		f.calls.map((call) => call.tool),
		["profile", "history", "thread"],
	);
	assert.equal(f.texts.length, 1);
	// The identity is cached for a day; later polls read only history.
	f.tick();
	await f.poll({ ...f.context, cursor: first.cursor });
	assert.deepEqual(
		f.calls.map((call) => call.tool),
		["profile", "history", "thread", "history"],
	);
	f.tick(86_400_000);
	await f.poll({ ...f.context, cursor: first.cursor });
	assert.equal(f.calls.filter((call) => call.tool === "profile").length, 2);
	assert.equal(f.calls.filter((call) => call.tool === "mentionsPrivate").length, 0);
	assert.equal(f.texts.length, 1);
});

test("a group handle resolves once by channel-scoped search, persists and matches ID-only mentions", async (t) => {
	const f = await fixture(t);
	const context = { ...f.context, config: { ...f.context.config, slackGroupHandles: ["oncall"] } };
	f.set(searchMany(["Groups: <@S0OTHER1><@S0ONCALL1>", "<@S0ONCALL1> please look", "Hello <@S0ONCALL1>"]));
	f.history(history([{ ts: parent, text: "Hello <!subteam^S0ONCALL1> , could one of you check?" }]));
	const first = await f.poll(context);
	assert.equal(first.items[0]?.externalId, `${channel}/${parent}`);
	const searchCall = f.calls.find((call) => call.tool === "mentionsPrivate")!;
	assert.deepEqual(searchCall.args.keywords, ["@oncall"]);
	assert.equal(searchCall.args.filters, `in:<#${channel}>`);
	assert.deepEqual(await f.store.slackGroups(["oncall"]), { oncall: { id: "S0ONCALL1", checkedAt: now } });
	// Another group's ID-only mention does not qualify.
	f.history(history([{ ts: "1791885600.000001", text: "Hello <!subteam^S0OTHER1>" }]));
	const restarted = createSlackPoller(f.store, { classifySlack: async () => assert.fail("not mentioned") }, () => now);
	const second = await restarted({ ...context, cursor: first.cursor });
	assert.deepEqual(second.items, []);
	assert.equal(f.calls.filter((call) => call.tool === "mentionsPrivate").length, 1, "resolved once, across restarts");
});

test("an unresolved or refused group search retries after a day without stopping discovery", async (t) => {
	const f = await fixture(t);
	const context = { ...f.context, config: { ...f.context.config, slackGroupHandles: ["oncall"] } };
	f.set(new SourceToolError("Search refused"));
	f.history(history([{ ts: parent, text: "Hello <!subteam^S0ONCALL1>" }]));
	const first = await f.poll(context);
	assert.deepEqual(first.items, []);
	assert.equal(first.issue, undefined);
	assert.equal((await f.store.slackGroups(["oncall"])).oncall?.id, null);
	f.tick();
	f.set(searchMany(["<@S0ONCALL1>", "<@S0ONCALL1>"]));
	await f.poll({ ...context, cursor: first.cursor });
	assert.equal(f.calls.filter((call) => call.tool === "mentionsPrivate").length, 1);
	f.tick(86_400_000);
	await f.poll({ ...context, cursor: first.cursor });
	assert.equal(f.calls.filter((call) => call.tool === "mentionsPrivate").length, 2);
	assert.equal((await f.store.slackGroups(["oncall"])).oncall?.id, "S0ONCALL1");
});

test("discovery reads leave the hourly budget to classification, which pins progress and resumes next UTC hour", async (t) => {
	const f = await fixture(t);
	for (let i = 0; i < SLACK_HOURLY_BUDGET; i++) await f.store.reserveSlack(channel, `${i + 1}.000002`, now, "budget");
	f.history(history([{ ts: parent, text: "<@U000000099> export crashes" }]));
	const limited = await f.poll(f.context);
	assert.equal(limited.issue, "slack_budget");
	assert.equal(f.texts.length, 0);
	assert.deepEqual(
		f.calls.map((call) => call.tool),
		["profile", "history"],
	);
	f.tick(3_600_000);
	const resumed = await f.poll({ ...f.context, cursor: limited.cursor });
	assert.equal(resumed.items.length, 1);
	assert.equal(f.texts.length, 1);
	const reads = f.calls.filter((call) => call.tool === "history");
	assert.equal(reads[1]?.args.oldest, reads[0]?.args.oldest);
	assert.equal(reads[1]?.args.latest, reads[0]?.args.latest);
});

test("option off preserves history behaviour and enabling it never hides/closes existing items or label effects", async (t) => {
	const f = await fixture(t);
	const projects = new ProjectStore(f.home);
	await projects.load();
	const labels = [{ name: "Client", description: "Client support", effect: "close" as const }];
	const project = await projects.create({ path: f.home, tracking: { slackChannels: [channel], slackLabels: labels } });
	let filtered = false;
	let newMention = false;
	const secondParent = "1791885600.000001";
	const registry = new SourceRegistry(projects, f.store, {
		call: async (_kind, tool): Promise<TrackingJson> => {
			if (tool === "history")
				return history([
					{ ts: parent, text: "An unmentioned crash" },
					...(newMention ? [{ ts: secondParent, text: "<@U000000099> another crash" }] : []),
				]);
			if (tool === "reactions") return { present: false };
			assert.equal(filtered, true);
			if (tool === "profile") return profile;
			assert.fail(`Unexpected tool ${tool}`);
		},
	});
	t.after(() => registry.stop());
	registry.register(
		"slack",
		createSlackPoller(
			f.store,
			{
				classifySlack: async (_path, _text, _signal, context) => {
					assert.deepEqual(context?.labels, labels);
					return { ...bug, label: "Client" };
				},
			},
			() => now,
		),
	);
	assert.equal((await registry.poll(`${project.id}:slack`)).status, "ok");
	const before = await f.store.list({ projectId: project.id, kind: "slack", dismissed: true });
	assert.equal(before.total, 1);
	filtered = true;
	await projects.update(project.id, {
		tracking: { slackChannels: [channel], slackLabels: labels, slackMentionOnlyChannels: [channel] },
	});
	assert.equal((await registry.listItems({ projectId: project.id, kind: "slack", dismissed: true })).total, 1);
	await registry.poll(`${project.id}:slack`);
	assert.deepEqual(
		(await f.store.list({ projectId: project.id, kind: "slack", dismissed: true })).items,
		before.items,
	);
	newMention = true;
	assert.equal((await registry.poll(`${project.id}:slack`)).status, "ok");
	const closed = await f.store.list({ projectId: project.id, kind: "slack", dismissed: true });
	assert.equal(closed.total, 1, "the classifier's close label cannot hide a qualifying mention");
	const mentionedItem = (await f.store.list({ projectId: project.id, kind: "slack" })).items.find((item) =>
		item.externalId.endsWith(secondParent),
	);
	assert.ok(mentionedItem);
	assert.equal(mentionedItem.slack?.status, "open");
	assert.equal(mentionedItem.metadata.mentionQualified, true);
	assert.equal(mentionedItem.metadata.label, "Client", "classification still supplies the label");
	assert.equal(
		await f.store.patch(mentionedItem.id, { slack: { status: "dismissed" } }).then((item) => item.slack?.status),
		"dismissed",
	);
});

test("filter edits cancel stale in-flight admission without invalidating existing source scope", async (t) => {
	const f = await fixture(t);
	const projects = new ProjectStore(f.home);
	await projects.load();
	const project = await projects.create({ path: f.home, tracking: { slackChannels: [channel] } });
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	t.after(() => release());
	const registry = new SourceRegistry(projects, f.store, {
		call: async (_kind, tool): Promise<TrackingJson> => {
			assert.equal(tool, "history");
			entered();
			await gate;
			return {
				messages: `Channel: #bugs (${channel})\n\n=== Message from Reporter at now ===\nMessage TS: ${parent}\n\nAn unmentioned crash\n`,
				pagination_info: "There are no more messages available.\n",
			};
		},
	});
	t.after(() => registry.stop());
	registry.register("slack", f.poll);
	const pending = registry.poll(`${project.id}:slack`);
	await started;
	await projects.update(project.id, { tracking: { slackChannels: [channel], slackMentionOnlyChannels: [channel] } });
	release();
	await pending;
	assert.equal((await f.store.list({ projectId: project.id })).total, 0);
	assert.equal(f.texts.length, 0);
});

test("maximum mention checkpoints remain bounded; group edits and search-era checkpoints restart only discovery", async (t) => {
	const f = await fixture(t);
	const names = Array.from({ length: 100 }, (_, n) => `C${String(n).padStart(199, "0")}`);
	const hash = (value: string) => createHash("sha256").update(value).digest("base64url").slice(0, 12);
	const groups = Array.from({ length: 30 }, (_, n) => `group-${n}`);
	const checkpoint = (scope: string) =>
		({
			version: 2,
			last: null,
			channels: Object.fromEntries(
				names.map((name) => [hash(name), ["1791800000.000000", "1791892800.000000", "x".repeat(96), now, now + 1]]),
			),
			mentions: Object.fromEntries(names.map((name) => [hash(name), [scope, 30, true]])),
		}) as unknown as TrackingJson;
	const cursor = checkpoint(hash(JSON.stringify(["history", groups])));
	assert.ok(Buffer.byteLength(JSON.stringify({ configKey: "x".repeat(64), lastPolledAt: now, cursor })) < 32 * 1024);
	let args: Record<string, unknown> | undefined;
	const call = async (tool: string, input: Record<string, unknown>): Promise<TrackingJson> => {
		if (tool === "profile") return profile;
		if (tool === "mentionsPrivate") return search();
		assert.equal(tool, "history");
		args = input;
		return { messages: `Channel: #bugs (${input.channel_id})\n\n`, pagination_info: historyEnd };
	};
	const config = { slackChannels: names, slackMentionOnlyChannels: names, slackGroupHandles: groups };
	const result = await f.poll({ ...f.context, cursor, config, call });
	assert.equal(args?.cursor, "x".repeat(96));
	await f.store.commit(f.project.id, "slack", [], {
		configKey: "x".repeat(64),
		lastPolledAt: now,
		cursor: result.cursor!,
	});
	await f.poll({
		...f.context,
		cursor: result.cursor,
		config: { ...config, slackGroupHandles: ["new-group"] },
		call,
	});
	assert.equal(args?.cursor, undefined);
	assert.equal(args?.oldest, `${Math.floor((now - 7 * 86_400_000) / 1000)}.000000`);
	// A checkpoint from search-based discovery holds a search cursor, never valid for history.
	await f.poll({ ...f.context, cursor: checkpoint(hash(JSON.stringify(groups))), config, call });
	assert.equal(args?.cursor, undefined);
});
