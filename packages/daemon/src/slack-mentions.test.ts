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
import { mentionsMe, parseSlackIdentity, parseSlackMentions } from "./slack-mentions.ts";
import { createSlackPoller } from "./slack-source.ts";
import { dedicatedSourceTool, SourceToolError, validSourceArguments } from "./source-mcp.ts";
import { type SourcePollContext, SourceRegistry } from "./sources.ts";
import { TrackedItemStore } from "./tracked-items.ts";
import { SLACK_DAILY_BUDGET } from "./tracked-items-disk.ts";

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
	let response: TrackingJson = search();
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
			if (tool === "mentions" || tool === "mentionsPrivate") return response;
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
		set: (value: TrackingJson) => {
			response = value;
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
	assert.equal(dedicatedSourceTool("slack", "mentions"), "slack_search_public");
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

test("personal mentions classify full bounded thread context and cache identity and thread reads", async (t) => {
	const f = await fixture(t);
	f.set(search("<@U000000099> please investigate"));
	const first = await f.poll(f.context);
	assert.equal(first.items.length, 1);
	assert.equal(first.items[0]?.externalId, `${channel}/${parent}`);
	assert.match(f.texts[0]!, /Export crashes[\s\S]*TypeError[\s\S]*Small files work/);
	assert.doesNotMatch(f.texts[0]!, /please investigate/);
	assert.deepEqual(
		f.calls.map((call) => call.tool),
		["profile", "mentions", "thread"],
	);
	assert.equal(f.calls[1]?.args.filters, `in:<#${channel}> with:<@U000000099>`);
	assert.deepEqual(f.calls[1]?.args.keywords, []);
	f.tick();
	await f.poll({ ...f.context, cursor: first.cursor });
	assert.equal(f.texts.length, 1);
	assert.deepEqual(
		f.calls.map((call) => call.tool),
		["profile", "mentions", "thread", "mentions"],
	);
});

test("non-qualifying threads never prepare a classifier; a late mention in a reply admits the parent", async (t) => {
	const f = await fixture(t);
	f.set(search("<!here> <!channel> <!everyone> @other-group"));
	const first = await f.poll(f.context);
	assert.deepEqual(first.items, []);
	assert.equal(f.texts.length, 0);
	assert.equal(f.calls.filter((call) => call.tool === "thread").length, 0);
	assert.equal(await f.store.slackCached(channel, parent, f.project.id), undefined);
	f.tick();
	f.set(search("New reply <@U000000099>", { ts: reply, parent }));
	const late = await f.poll({ ...f.context, cursor: first.cursor });
	assert.equal(late.items[0]?.externalId, `${channel}/${parent}`);
	assert.equal(f.texts.length, 1);
	assert.equal(f.calls[2]?.args.after, f.calls[1]?.args.before);
	// A later reply does not cause another thread read or classification once the parent is admitted.
	f.set(search("Another reply <@U000000099>", { ts: "1791885490.000001", parent }));
	await f.poll({ ...f.context, cursor: late.cursor });
	assert.equal(f.texts.length, 1);
	assert.equal(f.calls.filter((call) => call.tool === "thread").length, 1);
});

test("group mention searches rotate, pin pagination and preserve scope across a poller restart", async (t) => {
	const f = await fixture(t);
	const context = { ...f.context, config: { ...f.context.config, slackGroupHandles: ["oncall"] } };
	const first = await f.poll(context);
	f.set(search("<!subteam^S00001|@oncall> please", { ts: reply, parent, next: "NEXT" }));
	const group = await f.poll({ ...context, cursor: first.cursor });
	assert.equal(group.items[0]?.externalId, `${channel}/${parent}`);
	assert.deepEqual(f.calls[3]?.args.keywords, ["@oncall"]);
	assert.equal(f.calls[3]?.args.after, f.calls[1]?.args.after);
	const restarted = createSlackPoller(f.store, { classifySlack: async () => assert.fail("cached") }, () => now);
	f.set(search());
	const last = await restarted({ ...context, cursor: group.cursor });
	const searchCall = f.calls.at(-1)!;
	assert.equal(searchCall.args.cursor, "NEXT");
	assert.deepEqual(searchCall.args.keywords, ["@oncall"]);
	await f.poll({ ...context, cursor: last.cursor });
	assert.deepEqual(f.calls.at(-1)?.args.keywords, []);
	assert.equal(f.texts.length, 1);
});

test("private-channel late replies use scoped private search with persistent engine/cursor and no history scans", async (t) => {
	const f = await fixture(t);
	let late = false;
	const tools: Array<{ tool: string; args: Record<string, unknown> }> = [];
	const context = {
		...f.context,
		call: async (tool: string, args: Record<string, unknown>): Promise<TrackingJson> => {
			tools.push({ tool, args });
			if (tool === "profile") return profile;
			assert.equal(
				args.filters ?? `in:<#${args.channel_id}> with:<@U000000099>`,
				`in:<#${channel}> with:<@U000000099>`,
			);
			if (tool === "mentions") return search(); // A private channel can have a modern C-prefixed ID.
			if (tool === "mentionsPrivate") {
				assert.equal(args.channel_types, "public_channel,private_channel");
				return late
					? search("<@U000000099> help", { ts: reply, parent, ...(args.cursor ? {} : { next: "PRIVATE_NEXT" }) })
					: search();
			}
			if (tool === "thread") return slackThreadFixture;
			assert.fail(`Unexpected tool ${tool}`);
		},
	};
	const initial = await f.poll(context);
	assert.equal(initial.items.length, 0);
	assert.deepEqual(
		tools.map(({ tool }) => tool),
		["profile", "mentions", "mentionsPrivate"],
	);
	late = true;
	f.tick();
	const second = await f.poll({ ...context, cursor: initial.cursor });
	assert.equal(second.items[0]?.externalId, `${channel}/${parent}`);
	assert.deepEqual(
		tools.map(({ tool }) => tool),
		["profile", "mentions", "mentionsPrivate", "mentionsPrivate", "thread"],
	);
	assert.equal(f.texts.length, 1);
	const restarted = createSlackPoller(
		f.store,
		{ classifySlack: async () => assert.fail("already classified") },
		() => now,
	);
	await restarted({ ...context, cursor: second.cursor });
	assert.equal(tools.at(-1)?.tool, "mentionsPrivate");
	assert.equal(tools.at(-1)?.args.cursor, "PRIVATE_NEXT");
	assert.equal(f.texts.length, 1);
});

test("a public-only channel refusal falls back only to channel-scoped private-capable search", async (t) => {
	const f = await fixture(t);
	const used: string[] = [];
	const result = await f.poll({
		...f.context,
		call: async (tool, args) => {
			used.push(tool);
			if (tool === "mentions") throw new SourceToolError("Not a public channel");
			return f.context.call(tool, args);
		},
	});
	assert.deepEqual(result.items, []);
	assert.deepEqual(used, ["profile", "mentions", "mentionsPrivate"]);
});

test("daily budget includes discovery and thread reads, pins progress and resumes next UTC day", async (t) => {
	const f = await fixture(t);
	for (let i = 0; i < SLACK_DAILY_BUDGET - 2; i++) assert.equal(await f.store.reserveSlackRead(now), true);
	f.set(search("<@U000000099>"));
	const limited = await f.poll(f.context);
	assert.equal(limited.issue, "slack_budget");
	assert.equal(f.texts.length, 0);
	assert.deepEqual(
		f.calls.map((call) => call.tool),
		["profile", "mentions"],
	);
	assert.equal(await f.store.reserveSlackRead(now), false);
	assert.equal((await f.store.reserveSlack(channel, parent, now, f.project.id)).state, "budget");
	f.tick(86_400_000);
	const resumed = await f.poll({ ...f.context, cursor: limited.cursor });
	assert.equal(resumed.items.length, 1);
	assert.equal(f.texts.length, 1);
	assert.equal(f.calls[3]?.args.after, f.calls[1]?.args.after);
	assert.equal(f.calls[3]?.args.before, f.calls[1]?.args.before);
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
				return {
					messages: `Channel: #bugs (${channel})\n\n=== Message from Reporter at now ===\nMessage TS: ${parent}\n\nAn unmentioned crash\n`,
					pagination_info: "There are no more messages available.\n",
				};
			if (tool === "reactions") return { present: false };
			assert.equal(filtered, true);
			if (tool === "profile") return profile;
			if (tool === "mentions" || tool === "mentionsPrivate")
				return newMention ? search("<@U000000099>", { ts: secondParent }) : search();
			if (tool === "thread")
				return {
					...slackThreadFixture,
					messages: slackThreadFixture.messages.replace(parent, secondParent),
				};
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
	assert.equal(closed.total, 2, "a new qualifying thread still takes its classifier label's close effect");
	assert.ok(closed.items.every((item) => item.slack?.closedByLabel === "Client"));
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

test("maximum mention checkpoints remain bounded and group edits restart only channel discovery", async (t) => {
	const f = await fixture(t);
	const names = Array.from({ length: 100 }, (_, n) => `C${String(n).padStart(199, "0")}`);
	const hash = (value: string) => createHash("sha256").update(value).digest("base64url").slice(0, 12);
	const groups = Array.from({ length: 30 }, (_, n) => `group-${n}`);
	const scope = hash(JSON.stringify(groups));
	const cursor = {
		version: 2,
		last: null,
		channels: Object.fromEntries(
			names.map((name) => [hash(name), ["1791800000.000000", "1791892800.000000", "x".repeat(96), now, now + 1]]),
		),
		mentions: Object.fromEntries(names.map((name) => [hash(name), [scope, 30, true]])),
	} as unknown as TrackingJson;
	assert.ok(Buffer.byteLength(JSON.stringify({ configKey: "x".repeat(64), lastPolledAt: now, cursor })) < 32 * 1024);
	let args: Record<string, unknown> | undefined;
	const result = await f.poll({
		...f.context,
		cursor,
		config: { slackChannels: names, slackMentionOnlyChannels: names, slackGroupHandles: groups },
		call: async (tool, input) => {
			if (tool === "profile") return profile;
			assert.equal(tool, "mentionsPrivate");
			args = input;
			return search();
		},
	});
	assert.equal(args?.cursor, "x".repeat(96));
	await f.store.commit(f.project.id, "slack", [], {
		configKey: "x".repeat(64),
		lastPolledAt: now,
		cursor: result.cursor!,
	});
	const edited = await f.poll({
		...f.context,
		cursor: result.cursor,
		config: { slackChannels: names, slackMentionOnlyChannels: names, slackGroupHandles: ["new-group"] },
		call: async (_tool, input) => {
			args = input;
			return search();
		},
	});
	assert.equal(args?.cursor, undefined);
	assert.deepEqual(args?.keywords, []);
	assert.ok(edited.cursor);
});
