import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ProjectDashboard, ServerMessage, SessionSummary, SourceSignIn, TrackingSource } from "@pilot/protocol";
import { WebSocket } from "ws";
import { pollLinear } from "./linear-source.ts";
import type { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import type { SessionManager } from "./sessions.ts";
import { SourceSignInRequired } from "./source-mcp.ts";
import { SourceRegistry } from "./sources.ts";
import type { TerminalManager } from "./terminals.ts";
import { TrackedItemStore } from "./tracked-items.ts";

test("tracking HTTP, WS invalidation and DashboardProviders.tracked share project-scoped data", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-tracking-server-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({
		path: home,
		tracking: {
			slackChannels: ["C1"],
			slackLabels: [{ name: "Client", description: "App support", effect: "hide" }],
			linearTeam: "ENG",
		},
	});
	await mkdir(join(home, "other"));
	const other = await projects.create({ path: join(home, "other") });
	const items = new TrackedItemStore(join(home, "tracked.sqlite"));
	await items.load([project.id]);
	const tracking = new SourceRegistry(projects, items, {
		async call() {
			throw new SourceSignInRequired();
		},
		// A fake browser sign-in that waits until it is cancelled.
		signIn: (_kind, { signal }) =>
			new Promise<void>((_resolve, reject) =>
				signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
			),
	});
	tracking.register("linear", async (context) => {
		await context.call("issues", {});
		return { items: [] };
	});
	const chats = new Map<string, SessionSummary>();
	chats.set("foreign", { id: "foreign", projectId: other.id } as SessionSummary);
	const sessions = {
		list: () => [],
		get: (id: string) => chats.get(id),
		onChange: () => () => {},
		onArtifactsChanged: () => () => {},
		setWorkspaceProcessGuard() {},
	} as unknown as SessionManager;
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		{} as ModelCatalog,
		{ isRunning: () => false } as unknown as TerminalManager,
		undefined,
		undefined,
		undefined,
		undefined,
		tracking,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
	const ws = new WebSocket(root.replace("http:", "ws:") + "/ws");
	const messages: ServerMessage[] = [];
	ws.on("message", (data) => messages.push(JSON.parse(String(data))));
	t.after(async () => {
		ws.terminate();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await tracking.stop();
		await items.close();
		await rm(home, { recursive: true, force: true });
	});
	await once(ws, "open");
	async function until(check: () => boolean) {
		for (let i = 0; i < 300; i++) {
			if (check()) return;
			await delay(10);
		}
		assert.fail("No expected WS update");
	}
	await until(() => messages.some((message) => message.type === "sources"));
	const api = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
		fetch(root + path, {
			method,
			...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
		});
	const sources = (await (await api(`/sources?projectId=${project.id}`)).json()) as TrackingSource[];
	assert.equal(sources.length, 2);
	assert.equal((await api("/sources/missing/poll", {})).status, 404);
	assert.equal((await api(`/sources/${other.id}:linear/poll`, {})).status, 409);
	assert.equal((await api(`/sources/${project.id}:slack/poll`, {})).status, 503, "no poller installed");
	const auth = (await (await api(`/sources/${project.id}:linear/poll`, {})).json()) as TrackingSource;
	assert.equal(auth.status, "sign_in_required");
	assert.equal(auth.signInCommand, "pi mcp login linear");
	const teams = await (await api("/tracking/linear/teams")).json();
	assert.equal((await api("/tracking/linear/states")).status, 400);
	assert.equal((await api(`/tracking/linear/states?team=${"a".repeat(201)}`)).status, 400);
	assert.equal((await (await api("/tracking/linear/states?team=ENG")).json()).status, "sign_in_required");
	assert.deepEqual(teams, {
		status: "sign_in_required",
		items: [],
		error: "Sign in required",
		signInCommand: "pi mcp login linear",
	});
	assert.equal((await (await api("/tracking/slack/channels?query=bugs")).json()).status, "sign_in_required");
	assert.equal((await api("/tracking/slack/teams")).status, 404);
	const signIn = (await (await api("/tracking/linear/sign-in", {})).json()) as SourceSignIn;
	assert.equal(signIn.state, "waiting");
	assert.equal(
		((await (await api("/tracking/linear/sign-in", { again: true })).json()) as SourceSignIn).startedAt,
		signIn.startedAt,
		"one sign-in per server",
	);
	assert.equal((await api("/tracking/linear/sign-in", { again: "yes" })).status, 400);
	assert.equal((await api("/tracking/bogus/sign-in", {})).status, 404);
	assert.equal((await api("/tracking/slack/sign-in", undefined, "DELETE")).status, 404);
	await until(() =>
		messages.some(
			(message) =>
				message.type === "sources" &&
				message.sources.some((source) => source.kind === "linear" && source.signIn?.state === "waiting"),
		),
	);
	const listed = (await (await api(`/sources?projectId=${other.id}`)).json()) as TrackingSource[];
	assert.equal(listed.find((source) => source.kind === "linear")?.signIn?.state, "waiting", "shared by projects");
	const cancelled = (await (await api("/tracking/linear/sign-in", undefined, "DELETE")).json()) as SourceSignIn;
	assert.equal(cancelled.state, "cancelled");
	assert.ok(!JSON.stringify(cancelled).toLowerCase().includes("token"));
	ws.send(JSON.stringify({ type: "dashboard.subscribe", projectId: project.id }));
	await until(() => messages.some((message) => message.type === "dashboard"));
	await items.commit(
		project.id,
		"linear",
		Array.from({ length: 8 }, (_, i) => ({
			externalId: String(i),
			title: `Ticket ${i}`,
			url: `https://example.com/${i}`,
			status: "Todo",
			metadata: {},
			updatedAt: i,
		})),
	);
	await until(() =>
		messages.some((message) => message.type === "tracked.changed" && message.projectId === project.id),
	);
	await until(() =>
		messages.some((message) => message.type === "dashboard" && message.dashboard.tracked[0]?.total === 8),
	);
	const dashboard = (await (await api(`/projects/${project.id}/dashboard`)).json()) as ProjectDashboard;
	assert.equal(dashboard.tracked[0]?.items.length, 5);
	assert.equal(dashboard.tracked[0]?.status, "sign_in_required");
	assert.equal((await api("/tracked-items")).status, 400);
	assert.equal((await api(`/tracked-items?projectId=${project.id}&limit=101`)).status, 400);
	assert.equal((await api(`/tracked-items?projectId=${project.id}&kind=bogus`)).status, 400);
	const page = await (await api(`/tracked-items?projectId=${project.id}&limit=2`)).json();
	assert.equal(page.total, 8);
	assert.equal(page.items.length, 2);
	const id = page.items[0].id;
	assert.equal((await api(`/tracked-items/${id}`, { sessionId: "foreign" }, "PATCH")).status, 400);
	assert.equal((await api(`/tracked-items/${id}`, { missionId: "missing" }, "PATCH")).status, 400);
	assert.equal((await api(`/tracked-items/${id}`, { title: "forged" }, "PATCH")).status, 400);
	assert.equal((await api(`/tracked-items/${id}`, { dismissed: true }, "PATCH")).status, 200);
	assert.equal((await (await api(`/tracked-items?projectId=${project.id}&dismissed=true`)).json()).total, 1);
	assert.equal(tracking.dashboard(project.id)[0]?.total, 7);
	assert.equal((await (await api(`/tracked-items?projectId=${other.id}`)).json()).total, 0);
	await items.commit(project.id, "slack", [
		{
			externalId: "C1/1.000001",
			title: "Export help",
			url: "https://example.com/thread",
			status: "open",
			updatedAt: 1,
			metadata: { type: "question", label: null, severity: "low", channel: "C1" },
		},
	]);
	const slack = (await (await api(`/tracked-items?projectId=${project.id}&kind=slack`)).json()).items[0];
	assert.equal(slack.slack.type, "question");
	assert.equal(slack.slack.status, "open");
	assert.equal((await api(`/tracked-items/${id}`, { slack: { type: "bug" } }, "PATCH")).status, 400);
	assert.equal((await api(`/tracked-items/${slack.id}`, { slack: { label: "Not configured" } }, "PATCH")).status, 400);
	assert.equal((await api(`/tracked-items/${slack.id}`, { slack: { status: "working" } }, "PATCH")).status, 400);
	const eventCount = messages.filter((message) => message.type === "tracked.changed").length;
	const corrected = await (
		await api(
			`/tracked-items/${slack.id}`,
			{ slack: { type: "request", label: "Client", severity: "medium", status: "done" } },
			"PATCH",
		)
	).json();
	assert.equal(corrected.slack.label, "Client");
	assert.equal(corrected.status, "done");
	await until(() => messages.filter((message) => message.type === "tracked.changed").length > eventCount);
	const cleared = await (await api(`/tracked-items/${slack.id}`, { slack: { label: null } }, "PATCH")).json();
	assert.equal(cleared.slack.label, null);
	assert.equal(cleared.slack.overrides.label, null);
	chats.set("local", { id: "local", projectId: project.id } as SessionSummary);
	const started = await (await api(`/tracked-items/${slack.id}`, { sessionId: "local", start: true }, "PATCH")).json();
	assert.equal(started.status, "in_progress");
	assert.equal(started.slack.overrides.type, "request");
	const corrections = await (await api(`/tracking/slack/corrections?projectId=${project.id}`)).json();
	assert.equal(corrections.length, 2);
	assert.equal(corrections[0].values.label, null);
	assert.deepEqual(await (await api(`/tracking/slack/corrections?projectId=${other.id}`)).json(), []);
	assert.equal((await api("/tracking/slack/corrections")).status, 400);
	assert.equal((await api("/tracking/slack/corrections?projectId=missing")).status, 404);
	const saved = await (
		await api(
			`/projects/${project.id}`,
			{
				tracking: {
					slackChannels: ["C1"],
					// An older app's label: hideFromInbox: true is saved as the hide effect.
					slackLabels: [{ name: "Client", description: "App support", hideFromInbox: true }],
				},
			},
			"PATCH",
		)
	).json();
	assert.deepEqual(saved.tracking.slackLabels, [{ name: "Client", description: "App support", effect: "hide" }]);
	assert.equal(
		(
			await api(
				`/projects/${project.id}`,
				{
					tracking: {
						slackChannels: [],
						slackLabels: [{ name: "Client", description: "App support", hideFromInbox: 1 }],
					},
				},
				"PATCH",
			)
		).status,
		400,
	);
});

test("Linear cycle/fallback and transient prefill are exposed through the tracking and dashboard HTTP APIs", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-linear-api-"));
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: home, tracking: { slackChannels: [], linearTeam: "team-root" } });
	const items = new TrackedItemStore(join(home, "tracked.sqlite"));
	await items.load([project.id]);
	const recording = JSON.parse(await readFile(new URL("./fixtures/linear-current.json", import.meta.url), "utf8"));
	let fallback = false;
	let rejectStart!: () => void;
	let startAttempted!: () => void;
	const attempted = new Promise<void>((resolve) => {
		startAttempted = resolve;
	});
	const startGate = new Promise<void>((resolve) => {
		rejectStart = resolve;
	});
	t.after(rejectStart);
	const tracking = new SourceRegistry(projects, items, {
		async call(kind, tool, args) {
			assert.equal(kind, "linear");
			if (tool === "me") {
				startAttempted();
				await startGate;
				throw new Error("external secret");
			}
			if (tool === "cycles") return fallback ? [] : recording.cycles;
			if (tool === "states") {
				assert.deepEqual(args, { team: "team-child" });
				return {
					statuses: [
						{ id: "active", name: "In progress", type: "started" },
						{ id: "done", name: "Done", type: "completed" },
					],
				};
			}
			if (tool === "issue") return recording.issue;
			assert.equal(tool, "issues");
			assert.equal(args.assignee, "me");
			assert.equal(args.team, "team-root");
			assert.equal(args.includeSubTeams, true);
			const page = recording.pages[args.cursor ? 1 : 0];
			return args.state
				? {
						...page,
						issues: page.issues.filter((issue: { statusType: string }) => issue.statusType === args.state),
					}
				: page;
		},
	});
	tracking.register("linear", pollLinear);
	const sessions = {
		list: () => [],
		get: (id: string) => (id === "chat" ? { id, projectId: project.id } : undefined),
		onChange: () => () => {},
		onArtifactsChanged: () => () => {},
		setWorkspaceProcessGuard() {},
	} as unknown as SessionManager;
	const server = createDaemonServer(
		{ home, host: "127.0.0.1", port: 0 },
		sessions,
		projects,
		{} as ModelCatalog,
		{ isRunning: () => false } as unknown as TerminalManager,
		undefined,
		undefined,
		undefined,
		undefined,
		tracking,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await tracking.stop();
		await items.close();
		await rm(home, { recursive: true, force: true });
	});
	const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
	const poll = await fetch(`${root}/sources/${project.id}:linear/poll`, { method: "POST" });
	const states = await fetch(`${root}/tracking/linear/states?team=team-child`);
	assert.equal(states.status, 200);
	assert.deepEqual(await states.json(), { status: "ok", items: [{ id: "active", name: "In progress" }] });
	assert.equal(poll.status, 200);
	assert.equal((await poll.json()).linear.currentCycle.progress, 0.5);
	const dashboard = await (await fetch(`${root}/projects/${project.id}/dashboard`)).json();
	assert.equal(dashboard.tracked[0].linear.currentCycle.id, "cycle-1");
	// Open issues lead; done ones are a separate, collapsed group.
	assert.equal(dashboard.tracked[0].total, 2);
	assert.equal(dashboard.tracked[0].items.length, 1);
	assert.equal(dashboard.tracked[0].done.total, 1);
	const page = await (await fetch(`${root}/tracked-items?projectId=${project.id}&kind=linear`)).json();
	const item = page.items.find((item: { externalId: string }) => item.externalId === "issue-1");
	const prefill = await fetch(`${root}/tracked-items/${item.id}/prefill`);
	assert.equal(prefill.status, 200);
	assert.equal((await prefill.json()).gitBranchName, "eng-1-settings-refresh");
	assert.equal((await fetch(`${root}/tracked-items/missing/prefill`)).status, 404);
	assert.equal((await fetch(`${root}/tracked-items/${item.id}/excerpt`)).status, 409, "excerpts are Slack only");
	assert.equal((await fetch(`${root}/tracked-items/missing/excerpt`)).status, 404);
	assert.ok(!JSON.stringify(await items.require(item.id)).includes("description"));
	for (const body of [{ start: true }, { start: true, sessionId: "foreign" }, { start: true, missionId: "missing" }]) {
		const invalid = await fetch(`${root}/tracked-items/${item.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		assert.equal(invalid.status, 400);
	}
	const confirmed = await fetch(`${root}/tracked-items/${item.id}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sessionId: "chat", start: true }),
	});
	assert.equal(confirmed.status, 200, "binding returns while remote start is still gated");
	assert.equal((await confirmed.json()).sessionId, "chat");
	await attempted;
	const pending = tracking.startLinear(await items.require(item.id));
	rejectStart();
	await pending;
	const result = await items.require(item.id);
	assert.equal((result.metadata.linearStart as { outcome: string }).outcome, "error");
	assert.ok(!JSON.stringify(result).includes("secret"));

	fallback = true;
	await tracking.poll(`${project.id}:linear`);
	const status = tracking.require(`${project.id}:linear`);
	assert.equal(status.linear?.cycleStatus, "no_active_cycle");
	assert.equal((await tracking.listItems({ projectId: project.id })).total, 1);
});
