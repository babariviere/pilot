import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ProjectStore } from "./projects.ts";
import { SourceRegistry } from "./sources.ts";
import { SourceSignInRequired } from "./source-mcp.ts";
import { TrackedItemStore } from "./tracked-items.ts";
import type { TrackedInput } from "./tracked-items.ts";

const item: TrackedInput = {
	externalId: "1",
	title: "Bug",
	url: "https://example.com/1",
	status: "Todo",
	metadata: {},
	updatedAt: 1,
};
async function fixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "pilot-sources-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: home });
	const items = new TrackedItemStore(join(home, "tracked.sqlite"));
	await items.load([project.id]);
	const calls: unknown[] = [];
	const registry = new SourceRegistry(projects, items, {
		async call(...args) {
			calls.push(args.slice(0, 3));
			return { issues: [] };
		},
	});
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
	assert.throws(() => f.registry.poll(`${f.project.id}:linear`), /Configure/);
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
		/only slackChannels and linearTeam/,
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
