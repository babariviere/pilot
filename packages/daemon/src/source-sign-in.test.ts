import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { TrackedKind } from "@pilot/protocol";
import { ProjectStore } from "./projects.ts";
import { SourceSignInCancelled, SourceSignInFailed } from "./source-sign-in.ts";
import { SourceSignInRequired } from "./source-mcp.ts";
import { SourceRegistry } from "./sources.ts";
import { TrackedItemStore } from "./tracked-items.ts";

/** A fake browser login: each start waits until the test approves, fails or the signal aborts it. */
function fakeLogin() {
	const starts: Array<{
		kind: TrackedKind;
		again: boolean;
		signal: AbortSignal;
		approve(): void;
		fail(error: Error): void;
	}> = [];
	return {
		starts,
		signIn(kind: TrackedKind, options: { again: boolean; signal: AbortSignal }) {
			return new Promise<void>((resolve, reject) => {
				options.signal.addEventListener("abort", () => reject(new SourceSignInCancelled("cancelled")), {
					once: true,
				});
				starts.push({ kind, again: options.again, signal: options.signal, approve: resolve, fail: reject });
			});
		},
	};
}

async function fixture(t: TestContext, timeoutMs?: number) {
	const home = await mkdtemp(join(tmpdir(), "pilot-sign-in-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: home, tracking: { slackChannels: ["C1"], linearTeam: "ENG" } });
	const items = new TrackedItemStore(join(home, "tracked.sqlite"));
	await items.load([project.id]);
	const login = fakeLogin();
	let signedIn = false;
	const polls: string[] = [];
	const registry = new SourceRegistry(
		projects,
		items,
		{
			async call(kind) {
				polls.push(kind);
				if (!signedIn) throw new SourceSignInRequired();
				return { issues: [] };
			},
			signIn: login.signIn,
		},
		timeoutMs,
	);
	registry.register("linear", async (context) => {
		await context.call("issues", {});
		return { items: [] };
	});
	t.after(async () => {
		await registry.stop();
		await items.close();
		await rm(home, { recursive: true, force: true });
	});
	return {
		project,
		registry,
		login,
		polls,
		signIn: () => {
			signedIn = true;
		},
		linear: () => registry.require(`${project.id}:linear`),
	};
}
async function until(check: () => boolean, message = "condition") {
	for (let i = 0; i < 500; i++) {
		if (check()) return;
		await delay(10);
	}
	assert.fail(`Timed out waiting for ${message}`);
}

test("sign-in waits for the browser, reports done on every project source, then resyncs that source", async (t) => {
	const f = await fixture(t);
	f.registry.startPolling("linear");
	await f.registry.poll(`${f.project.id}:linear`);
	assert.equal(f.linear().status, "sign_in_required");
	const changes: string[] = [];
	f.registry.onChange((change) => changes.push(change.type));
	const waiting = f.registry.signIn("linear");
	assert.equal(waiting.state, "waiting");
	assert.equal(waiting.kind, "linear");
	assert.ok(waiting.expiresAt > waiting.startedAt);
	assert.equal(f.linear().signIn?.state, "waiting");
	assert.equal(f.registry.require(`${f.project.id}:slack`).signIn, undefined, "per server");
	assert.ok(changes.includes("sources"));
	await until(() => f.login.starts.length === 1, "login start");
	assert.deepEqual(
		{ kind: f.login.starts[0]!.kind, again: f.login.starts[0]!.again },
		{ kind: "linear", again: false },
	);
	// One login per server: repeated clicks return the running sign-in without a second browser flow.
	assert.equal(f.registry.signIn("linear", true).startedAt, waiting.startedAt);
	await delay(20);
	assert.equal(f.login.starts.length, 1);
	f.signIn();
	const before = f.polls.length;
	f.login.starts[0]!.approve();
	await until(() => f.linear().signIn?.state === "done", "done");
	assert.ok(f.linear().signIn?.finishedAt);
	// The sign-in-required backoff is cleared and the source polls again without waiting five minutes.
	await until(() => f.linear().status === "ok", "resync");
	assert.ok(f.polls.length > before);
});

test("cancel, failure and timeout end a waiting sign-in, and a new one can start", async (t) => {
	const f = await fixture(t, 400);
	f.registry.signIn("slack", true);
	await until(() => f.login.starts.length === 1, "login start");
	assert.equal(f.login.starts[0]!.again, true);
	const cancelled = f.registry.cancelSignIn("slack");
	assert.equal(cancelled.state, "cancelled");
	assert.equal(f.login.starts[0]!.signal.aborted, true);
	assert.equal(f.registry.require(`${f.project.id}:slack`).signIn?.state, "cancelled");
	assert.equal(f.registry.cancelSignIn("slack").state, "cancelled", "cancelling again is harmless");
	assert.throws(() => f.registry.cancelSignIn("linear"), /No sign-in/);

	f.registry.signIn("slack");
	await until(() => f.login.starts.length === 2, "second start");
	f.login.starts[1]!.fail(new SourceSignInFailed("The slack MCP server is turned off in pi."));
	await until(() => f.registry.require(`${f.project.id}:slack`).signIn?.state === "failed", "failed");
	assert.equal(f.registry.require(`${f.project.id}:slack`).signIn?.error, "The slack MCP server is turned off in pi.");

	f.registry.signIn("slack");
	await until(() => f.login.starts.length === 3, "third start");
	f.login.starts[2]!.fail(new Error("secret server text"));
	await until(() => f.registry.require(`${f.project.id}:slack`).signIn?.state === "failed", "failed");
	assert.equal(f.registry.require(`${f.project.id}:slack`).signIn?.error, "Sign-in didn't finish. Try again.");

	// Bounded: an unanswered browser flow times out and reports why.
	f.registry.signIn("linear");
	await until(() => f.linear().signIn?.state === "failed", "timeout");
	assert.match(f.linear().signIn?.error ?? "", /timed out/);
	assert.equal(f.login.starts.at(-1)!.signal.aborted, true);
});

test("stopping tracking cancels a waiting sign-in, and clients without sign-in report it", async (t) => {
	const f = await fixture(t);
	f.registry.signIn("linear");
	await until(() => f.login.starts.length === 1, "login start");
	await f.registry.stop();
	assert.equal(f.login.starts[0]!.signal.aborted, true);
	assert.throws(() => f.registry.signIn("linear"), /stopped/);

	const home = await mkdtemp(join(tmpdir(), "pilot-sign-in-none-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const items = new TrackedItemStore(join(home, "tracked.sqlite"));
	await items.load([]);
	const registry = new SourceRegistry(projects, items, { call: async () => ({}) });
	t.after(async () => {
		await registry.stop();
		await items.close();
		await rm(home, { recursive: true, force: true });
	});
	assert.throws(() => registry.signIn("slack"), /unavailable/);
});
