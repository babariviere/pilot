import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { Conflict } from "./errors.ts";
import { MissionStore } from "./missions.ts";
import { ProjectStore } from "./projects.ts";
import { SOURCE_WRITE_TOOLS, SourceSignInRequired } from "./source-tool-rules.ts";
import { SourceRegistry, type SourceRegistryOptions } from "./sources.ts";
import type { TrackedInput } from "./tracked-items.ts";
import { TrackedItemStore } from "./tracked-items.ts";

const item: TrackedInput = {
	externalId: "1",
	title: "Bug",
	url: "https://example.com/1",
	status: "Todo",
	metadata: {},
	updatedAt: 1,
};
async function fixture(t: TestContext, options: SourceRegistryOptions = {}) {
	const home = await mkdtemp(join(tmpdir(), "pilot-sources-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: home });
	const items = new TrackedItemStore(join(home, "tracked.sqlite"));
	await items.load([project.id]);
	const calls: unknown[] = [];
	const registry = new SourceRegistry(
		projects,
		items,
		{
			async call(...args) {
				calls.push(args.slice(0, 3));
				return { issues: [] };
			},
		},
		options,
	);
	t.after(async () => {
		await registry.stop();
		await items.close();
		await rm(home, { recursive: true, force: true });
	});
	return { home, projects, project, items, registry, calls };
}
test("sources are opt-in and call only their dedicated server", async (t) => {
	const f = await fixture(t);
	assert.equal(f.registry.dashboard(f.project.id).length, 0);
	assert.ok(f.registry.list().every((source) => source.status === "not_configured"));
	for (const kind of ["linear", "slack"]) {
		assert.throws(
			() => f.registry.poll(`${f.project.id}:${kind}`),
			(error) => {
				assert.ok(error instanceof Conflict);
				assert.equal(error.message, "Attach a Linear team or Slack channels in project settings first");
				return true;
			},
		);
	}
	assert.deepEqual(f.calls, [], "unconfigured sources must never call their server");
	assert.throws(() => f.registry.require("bogus"), /Unknown/);
	await f.projects.update(f.project.id, {
		tracking: {
			slackChannels: [" C1 ", "C1"],
			linearTeam: " ENG ",
		},
	});
	assert.deepEqual(f.projects.require(f.project.id).tracking?.slackChannels, ["C1"]);
	assert.equal(f.registry.list(f.project.id)[0]?.status, "idle");
	const reopened = new ProjectStore(f.home);
	await reopened.load();
	assert.deepEqual(reopened.require(f.project.id).tracking, f.projects.require(f.project.id).tracking);
	await assert.rejects(
		f.projects.update(f.project.id, { tracking: { slackChannels: [1] } as never }),
		/slackChannels/,
	);
	await assert.rejects(
		f.projects.update(f.project.id, {
			tracking: { slackChannels: [], mcp: { linear: { server: "alternative", tools: {} } } } as never,
		}),
		/Tracking supports only/,
	);
	f.registry.register("linear", async (context) => {
		await context.call("issues", { team: context.config.linearTeam });
		return { items: [item], cursor: "next" };
	});
	await f.registry.poll(`${f.project.id}:linear`);
	assert.deepEqual(f.calls[0], ["linear", "issues", { team: "ENG" }]);
	assert.equal(f.registry.dashboard(f.project.id)[0]?.total, 1);
	await f.projects.update(f.project.id, { tracking: { slackChannels: [], linearTeam: "" } });
	assert.deepEqual(f.registry.dashboard(f.project.id), []);
	assert.equal(f.calls.length, 1);
});

test("legacy project overrides are discarded durably without losing opt-in settings", async (t) => {
	const f = await fixture(t);
	await writeFile(
		join(f.home, "projects.json"),
		JSON.stringify([
			{
				...f.project,
				tracking: {
					slackChannels: ["C1"],
					linearTeam: "ENG",
					mcp: { linear: { server: "alternative", tools: { issues: "old_issues" } } },
				},
			},
		]),
	);
	const reopened = new ProjectStore(f.home);
	await reopened.load();
	assert.deepEqual(reopened.require(f.project.id).tracking, { slackChannels: ["C1"], linearTeam: "ENG" });
	assert.deepEqual(JSON.parse(await readFile(join(f.home, "projects.json"), "utf8"))[0].tracking, {
		slackChannels: ["C1"],
		linearTeam: "ENG",
	});
	const registry = new SourceRegistry(reopened, f.items, {
		async call(kind, tool) {
			assert.equal(kind, "linear");
			assert.equal(tool, "issues");
			return { issues: [] };
		},
	});
	t.after(() => registry.stop());
	await f.items.commit(f.project.id, "linear", [item], {
		configKey: "legacy-binding",
		lastPolledAt: 1,
		cursor: "old-cursor",
	});
	registry.register("linear", async (context) => {
		assert.equal(context.cursor, undefined);
		await context.call("issues", {});
		return { items: [], cursor: "dedicated-cursor" };
	});
	await registry.poll(`${f.project.id}:linear`);
	assert.equal(f.items.checkpoint(`${f.project.id}:linear`)?.cursor, "dedicated-cursor");
	assert.equal((await f.items.list({ projectId: f.project.id })).total, 1);
});
test("single flight, cursor commit, failures and sign-in status are isolated per source", async (t) => {
	const f = await fixture(t);
	await f.projects.update(f.project.id, { tracking: { slackChannels: ["C1"], linearTeam: "ENG" } });
	t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
	let finish!: () => void,
		polls = 0,
		auth = false,
		failure = false;
	f.registry.register("linear", async (context) => {
		polls++;
		if (auth) throw new SourceSignInRequired("secret detail");
		if (failure) throw new Error("secret detail");
		if (polls === 1)
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
		else assert.equal(context.cursor, "next");
		return { items: [item], cursor: "next" };
	});
	f.registry.register("slack", async () => {
		throw new SourceSignInRequired("secret");
	});
	const id = `${f.project.id}:linear`;
	const first = f.registry.poll(id);
	assert.equal(first, f.registry.poll(id));
	assert.equal(f.registry.require(id).status, "syncing");
	await Promise.resolve();
	finish();
	await first;
	assert.equal(polls, 1);
	assert.equal(f.registry.require(id).status, "ok");
	const checkpoint = f.items.checkpoint(id);
	await f.registry.poll(`${f.project.id}:slack`);
	assert.equal(f.registry.require(`${f.project.id}:slack`).signInCommand, "pi mcp login slack");
	assert.equal(f.registry.require(id).status, "ok");
	failure = true;
	await f.registry.poll(id);
	assert.equal(f.registry.require(id).status, "error");
	assert.deepEqual(f.items.checkpoint(id), checkpoint);
	assert.equal(f.registry.dashboard(f.project.id)[0]?.total, 1, "errors retain last items");
	auth = true;
	t.mock.timers.tick(30_000);
	await f.registry.poll(id);
	assert.equal(f.registry.require(id).status, "sign_in_required");
	assert.ok(!JSON.stringify(f.registry.list()).includes("secret"));
	auth = false;
	failure = false;
	t.mock.timers.tick(300_000);
	await f.registry.poll(id);
	assert.equal(f.registry.require(id).status, "ok");
});
test("configuration changes cancel obsolete polls, ignore late results and reset cursors", async (t) => {
	const f = await fixture(t);
	await f.projects.update(f.project.id, { tracking: { slackChannels: [], linearTeam: "A" } });
	let finish!: (value: { items: TrackedInput[]; cursor: string }) => void;
	let signal!: AbortSignal;
	f.registry.register("linear", async (context) => {
		signal = context.signal;
		assert.equal(context.cursor, undefined);
		return new Promise((resolve) => {
			finish = resolve;
		});
	});
	const id = `${f.project.id}:linear`,
		pending = f.registry.poll(id);
	await Promise.resolve();
	await f.projects.update(f.project.id, { tracking: { slackChannels: [], linearTeam: "B" } });
	assert.equal(signal.aborted, true);
	await pending;
	finish({ items: [item], cursor: "stale" });
	await Promise.resolve();
	assert.equal((await f.items.list({ projectId: f.project.id })).total, 0);
	assert.equal(f.registry.require(id).status, "idle");
	assert.equal(f.items.checkpoint(id), undefined);
});
test("global concurrency is bounded and shutdown cancels adapters that ignore the signal", async (t) => {
	const f = await fixture(t);
	await f.projects.update(f.project.id, { tracking: { slackChannels: ["C1"], linearTeam: "A" } });
	const otherDir = join(f.home, "other");
	await mkdir(otherDir);
	const other = await f.projects.create({ path: otherDir, tracking: { slackChannels: [], linearTeam: "B" } });
	f.registry.register("linear", () => new Promise(() => {}));
	f.registry.register("slack", () => new Promise(() => {}));
	const a = f.registry.poll(`${f.project.id}:linear`),
		b = f.registry.poll(`${f.project.id}:slack`);
	assert.throws(() => f.registry.poll(`${other.id}:linear`), /busy/);
	await f.registry.stop();
	await Promise.all([a, b]);
	assert.throws(() => f.registry.poll(`${other.id}:linear`), /stopped/);
});

test("changing Slack channels cancels waiting reads without backing off the new configuration", async (t) => {
	let entered!: (signal: AbortSignal) => void;
	const waiting = new Promise<AbortSignal>((resolve) => {
		entered = resolve;
	});
	const f = await fixture(t, {
		pollers: { slack: async () => ({ items: [] }) },
		slack: {
			waiting: async ({ signal }) => {
				entered(signal);
				await new Promise(() => {});
			},
		},
	});
	await f.projects.update(f.project.id, { tracking: { slackChannels: ["C1"] } });
	const id = `${f.project.id}:slack`;
	const poll = f.registry.poll(id);
	const signal = await waiting;
	await f.projects.update(f.project.id, { tracking: { slackChannels: ["C2"] } });
	assert.equal(signal.aborted, true);
	assert.notEqual((await poll).status, "error");
	assert.deepEqual(f.calls, []);
});
test("Linear items managed by a mission report that mission on the dashboard and intake", async (t) => {
	const missions = new MissionStore(":memory:");
	t.after(() => missions.close());
	const f = await fixture(t, {
		linear: { managedMissions: (projectId, ids) => missions.managedLinearMissions(projectId, ids) },
	});
	const issueId = "3f811447-b574-4d82-b36c-5190a4e15bba";
	const mission = missions.create({ projectId: f.project.id, title: "Seasonal template", tasks: [{ title: "A" }] });
	const manager = missions.addResource(mission.id, {
		url: "https://linear.app/acme/issue/HS-1314",
		linearRole: "managed",
	});
	const record = missions.linearSyncRecord(manager.id)!;
	record.status = { ...record.status, issueId };
	assert.ok(missions.saveLinearSync(manager.id, record.version, record));
	await f.projects.update(f.project.id, { tracking: { slackChannels: [], linearTeam: "ENG" } });
	f.registry.register("linear", async () => ({
		items: [
			{ ...item, externalId: issueId, status: "In Progress" },
			{ ...item, externalId: "other", url: "https://example.com/2" },
		],
		cursor: "next",
	}));
	await f.registry.poll(`${f.project.id}:linear`);
	const links = (items: Array<{ externalId?: string; missionId?: string; missionIds?: string[] }>) =>
		Object.fromEntries(items.map((row) => [row.externalId, [row.missionId, row.missionIds]]));
	const expected = { [issueId]: [mission.id, [mission.id]], other: [undefined, undefined] };
	assert.deepEqual(links(f.registry.dashboard(f.project.id)[0]!.items), expected);
	const intake = (await f.registry.intakeSources(f.project.id)).find((source) => source.kind === "linear")!;
	assert.deepEqual(links(intake.items), expected);
	assert.equal(missions.managedLinearMissions("another-project", [issueId]).size, 0, "other projects stay unlinked");
});

test("source reads never call a write tool", async (t) => {
	const f = await fixture(t);
	await f.projects.update(f.project.id, { tracking: { slackChannels: [], linearTeam: "ENG" } });
	const refused: string[] = [];
	f.registry.register("linear", async (context) => {
		for (const tool of SOURCE_WRITE_TOOLS)
			await context.call(tool, {}).catch((error: Error) => refused.push(error.message));
		return { items: [] };
	});
	await f.registry.poll(`${f.project.id}:linear`);
	assert.deepEqual(
		refused,
		[...SOURCE_WRITE_TOOLS].map(() => "Source reads cannot write"),
	);
	assert.deepEqual(f.calls, []);
});
