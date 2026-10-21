import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { ControlPermission, KernelCommand, KernelPacket } from "@pilot/kernel";
import type { ControlAuthorization } from "@pilot/protocol";
import { pilotPrompt } from "../../kernel/src/policy.ts";
import { controlPermissionBlock, inheritedControlPermission, nativeToolPolicy } from "../../kernel/src/tool-policy.ts";
import { ControlPilot } from "./control-pilot.ts";
import { ModelCatalog } from "./models.ts";
import type { PermissionRequestState } from "./permission-requests.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager, type SessionWorker } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";
import { WatchService } from "./watch-service.ts";

const caller = SessionManager.CONTROL_ID;
const userMessage = { conversationId: "1", submissionId: 10, entryId: 20, requestId: "typed-user" };

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "control-publish-"));
	const home = join(root, "home");
	const source = join(root, "source");
	await mkdir(source);
	const projects = new ProjectStore(home);
	await projects.load();
	const watches = new WatchService(join(home, "watches.sqlite"));
	const managers: SessionManager[] = [];
	const requests: Array<{ sessionId: string; command: KernelCommand }> = [];
	const admitted = new Set<string>();
	const awaitingAdmission = new Map<string, () => void>();
	const workers: Array<{ spec: Extract<KernelCommand, { type: "start" }>["spec"]; worker: SessionWorker }> = [];
	const open = async () => {
		const sessions = new SessionManager(home, projects, undefined, {
			title: async () => undefined,
			worker: (spec, onPacket, onExit) => {
				const worker: SessionWorker = {
					ready: Promise.resolve(),
					state: "idle",
					busy: false,
					send: () => {},
					request: async (command) => {
						requests.push({ sessionId: spec.sessionId, command });
						if (command.type === "input") {
							const packet: KernelPacket = {
								type: "accepted",
								requestId: command.requestId,
								delivery: "delivered",
							};
							onPacket(packet);
							worker.state = "working";
							onPacket({ type: "working", working: true });
							admitted.add(spec.sessionId);
							awaitingAdmission.get(spec.sessionId)?.();
						}
					},
					close: async () => {
						onExit(worker, 0);
					},
				};
				workers.push({ spec, worker });
				return worker;
			},
		});
		managers.push(sessions);
		// Explicit legacy fixture, never the production default.
		sessions.setControlRoleGuard(() => true);
		await sessions.load();
		await sessions.ensureControlChat();
		const service = new ControlPilot({
			isControl: (id) => sessions.isControlSession(id),
			sessions,
			controlPermission: sessions.controlPermission.bind(sessions),
			authorizations: () => sessions.controlAuthorizations(),
			turnOrigin: async () => ({ requestId: userMessage.requestId, userMessage }),
			projects: () => [],
			missions: () => [],
			linear: () => [],
			watches,
			mutations: {
				audit: () => sessions.controlAudit(),
				startProject: (request, permission) =>
					sessions.controlStart(
						() => sessions.spawn({ cwd: source, message: request.message, mode: request.mode }),
						permission,
					),
				startTask: async () => {
					throw new Error("unused");
				},
				send: sessions.sendReported.bind(sessions),
			},
		});
		return { sessions, service };
	};
	const first = await open();
	let operation = 0;
	const authorize = (targets: unknown[], level = "publish") =>
		first.service.call(
			caller,
			"authorize",
			{
				scope: "Publish this change only",
				level,
				targets,
			},
			`grant-${++operation}`,
		) as Promise<ControlAuthorization>;
	const start = async (level: "investigate" | "implement" = "implement") => {
		const grant = await authorize([{ kind: "project", id: "p" }], level);
		const result = (await first.service.call(
			caller,
			"start",
			{
				projectId: "p",
				message: "Implement the fix, push the task branch and open a PR.",
				model: "test/model",
				mode: level === "implement" ? "build" : "ask",
				authorizationId: grant.id,
			},
			`start-${++operation}`,
		)) as { id: string };
		if (!admitted.has(result.id))
			await new Promise<void>((resolve) => {
				awaitingAdmission.set(result.id, resolve);
			});
		return { id: result.id, grant };
	};
	const upgrade = (id: string, authorizationId: string, operationId = `upgrade-${++operation}`, extra = {}) =>
		first.service.call(
			caller,
			"upgrade_permission",
			{ sessionId: id, authorizationId, level: "publish", ...extra },
			operationId,
		);
	const stored = async (id: string) =>
		JSON.parse(await readFile(join(home, "sessions", id, "meta.json"), "utf8")) as {
			controlPermission?: ControlPermission;
			pendingControlPermission?: ControlPermission;
			permissionRequest?: PermissionRequestState;
		};
	t.after(async () => {
		for (const manager of managers) await manager.shutdown();
		await watches.close();
		await rm(root, { recursive: true, force: true });
	});
	const waitForAdmission = async (id: string) => {
		if (!admitted.has(id)) await new Promise<void>((resolve) => awaitingAdmission.set(id, resolve));
	};
	return {
		...first,
		home,
		source,
		projects,
		open,
		workers,
		authorize,
		start,
		upgrade,
		stored,
		requests,
		waitForAdmission,
	};
}

const deliveryCommands = ["jj git push --bookmark fix/example", "git push origin fix/example", "gh pr create --fill"];

test("Build push reaches Git and reports genuine missing repository access", async (t) => {
	const permission: ControlPermission = { authorizationId: "build", level: "implement" };
	assertBuildDelivery(permission);
	// Exercise a real, disposable Git repository with unavailable remote access, never a network remote.
	const root = await mkdtemp(join(tmpdir(), "build-delivery-remote-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	assert.equal(spawnSync("git", ["-c", "init.templateDir=", "init", root]).status, 0);
	assert.equal(
		spawnSync("git", [
			"-C",
			root,
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"--allow-empty",
			"-m",
			"fixture",
		]).status,
		0,
	);
	const args = ["-C", root, "push", join(root, "missing-remote"), "HEAD:refs/heads/fix/example"];
	assert.equal(controlPermissionBlock(permission, "bash", { command: `git ${args.join(" ")}` }), undefined);
	const pushed = spawnSync("git", args, { encoding: "utf8" });
	assert.notEqual(pushed.status, 0);
	assert.match(pushed.stderr, /does not appear to be a git repository/);
	assert.doesNotMatch(pushed.stderr, /local.only|publishing approval/);
});

function assertBuildDelivery(permission: ControlPermission | undefined) {
	let before: (event: { toolName: string; input: Record<string, unknown> }) => unknown = () => undefined;
	nativeToolPolicy(permission)({
		on: (_event: string, handler: typeof before) => {
			before = handler;
		},
	} as never);
	for (const command of deliveryCommands) {
		assert.equal(controlPermissionBlock(permission, "bash", { command }), undefined);
		assert.equal(before({ toolName: "bash", input: { command } }), undefined);
		assert.equal(before({ toolName: "jobs", input: { action: "start", command } }), undefined);
	}
	const prompt = pilotPrompt({
		controlPermission: permission,
		requirePullRequest: true,
		workspace: { source: "/source", base: "main", jj: true },
	});
	assert.match(prompt, /push the task branch and open a pull request/);
	assert.doesNotMatch(prompt, /locally only|only the app's Allow|Do not push, open/);
	assert.match(prompt, /Merges still require user confirmation|Never push the default branch or merge/);
}

test("ordinary and delegated Build can fulfill an explicit PR request without a second approval", async (t) => {
	const f = await fixture(t);
	const ordinary = await f.sessions.spawn({
		cwd: f.source,
		mode: "build",
		message: "Fix this, push the task branch and open a PR.",
	});
	await f.waitForAdmission(ordinary.id);
	const delegated = await f.start();
	for (const id of [ordinary.id, delegated.id]) {
		const permission = f.workers.find((w) => w.spec.sessionId === id)!.spec.pilot?.controlPermission;
		assertBuildDelivery(permission);
		if (permission) assertBuildDelivery(inheritedControlPermission(JSON.stringify(permission)));
		assert.equal(f.sessions.get(id)?.permissionUpgradeRequest, undefined);
		assert.equal((await f.stored(id)).permissionRequest, undefined);
	}
	const sendGrant = await f.authorize([{ kind: "chat", id: delegated.id }], "implement");
	const sent = await f.service.call(
		caller,
		"send",
		{
			sessionId: delegated.id,
			message: "Push the task branch and open a PR.",
			level: "publish",
			authorizationId: sendGrant.id,
		},
		"publish-follow-up",
	);
	assert.doesNotMatch(JSON.stringify(sent), /permission unchanged|app approval/);
	assertBuildDelivery(f.sessions.controlPermission(delegated.id));
	await assert.rejects(f.upgrade(delegated.id, delegated.grant.id), /no publishing approval is required/);
	assert.equal((await f.stored(delegated.id)).permissionRequest, undefined);
});

test("persisted implement sessions resume delivery without consuming old pending approvals or changing history", async (t) => {
	const f = await fixture(t);
	const { id, grant } = await f.start();
	await f.sessions.shutdown();
	const path = join(f.home, "sessions", id, "meta.json");
	const meta = JSON.parse(await readFile(path, "utf8"));
	meta.permissionRequest = {
		id: "obsolete",
		chatId: id,
		chatTitle: "Old Build",
		level: "publish",
		scope: "Open a PR",
		requestedBy: caller,
		authorizationId: "old-grant",
		status: "pending",
		createdAt: 1,
		expiresAt: 2,
	};
	meta.pendingControlPermission = { authorizationId: "old-grant", level: "publish", approvalRequestId: "obsolete" };
	await writeFile(path, JSON.stringify(meta));
	const reopened = await f.open();
	const storedBefore = await f.stored(id);
	assert.deepEqual(reopened.sessions.controlPermission(id), { authorizationId: grant.id, level: "implement" });
	assertBuildDelivery(await reopened.sessions.prepareControlPermission(id));
	assert.equal(reopened.sessions.get(id)?.permissionUpgradeRequest, undefined);
	assert.doesNotMatch(reopened.sessions.get(id)?.outcomeReason ?? "", /Allow publish|App approval/);
	await assert.rejects(reopened.sessions.decideControlPermission(id, "obsolete", true), /obsolete/);
	assert.deepEqual(await f.stored(id), storedBefore, "no approval consumption or history mutation is needed");
	assert.equal(f.requests.filter((r) => r.sessionId === caller).length, 0, "no legacy decision notices replayed");
	await reopened.sessions.send(id, "Please push the task branch and open a PR.", "followUp");
	assertBuildDelivery(reopened.sessions.controlPermission(id));
});

test("Ask permissions and merge/review safeguards remain blocked while Build delivery is allowed", async (t) => {
	const f = await fixture(t);
	const ask = await f.start("investigate");
	for (const command of [...deliveryCommands, "git commit -m fix", "rm -rf /source"]) {
		assert.match(
			controlPermissionBlock(f.sessions.controlPermission(ask.id), "bash", { command })!,
			/Ask\/read-only/,
		);
	}
	await assert.rejects(f.upgrade(ask.id, ask.grant.id), /Read-only roles cannot be upgraded/);
	for (const command of [
		"gh repo delete owner/repo --yes",
		"gh release delete v1 --yes",
		"gh api repos/owner/repo -X DELETE",
		"gh api graphql -f query='mutation { deleteRepository(input: {repositoryId: \"fixture\"}) { clientMutationId } }'",
	])
		assert.match(
			controlPermissionBlock({ authorizationId: "build", level: "implement" }, "bash", { command })!,
			/destructive GitHub actions/,
		);
	assert.match(
		controlPermissionBlock({ authorizationId: "build", level: "implement" }, "mcp__github__delete_branch", {})!,
		/destructive GitHub actions/,
	);
	for (const permission of [undefined, { authorizationId: "build", level: "implement" } as const]) {
		let before: (event: { toolName: string; input: Record<string, unknown> }) => { block: boolean } | undefined =
			() => undefined;
		nativeToolPolicy(permission)({
			on: (_event: string, handler: typeof before) => {
				before = handler;
			},
		} as never);
		for (const command of ["gh pr merge 12 --squash", "gh pr merge 12 --auto", "gh pr review 12 --approve"])
			assert.equal(before({ toolName: "bash", input: { command } })?.block, true);
	}
});

test("retired native publishing decisions reject stale requests, including authenticated app calls", async (t) => {
	const f = await fixture(t);
	const { id } = await f.start();
	const terminals = new TerminalManager();
	const args: Parameters<typeof createDaemonServer> = [
		{ home: f.home, host: "127.0.0.1", port: 0 },
		f.sessions,
		f.projects,
		new ModelCatalog("/unused"),
		terminals,
	];
	args[18] = {
		authenticate: async (value: unknown) => {
			if (value !== "native-fixture") throw new Error("Native only");
		},
	} as unknown as NonNullable<(typeof args)[18]>;
	const server = createDaemonServer(...args);
	t.after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		terminals.shutdown();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/${id}/permission-upgrade`;
	for (const native of [false, true]) {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(native ? { "x-pilot-github-capability": "native-fixture" } : {}),
			},
			body: JSON.stringify({ id: "obsolete", allow: true }),
		});
		await response.arrayBuffer();
		assert.equal(response.status, native ? 409 : 403);
	}
	assert.equal((await f.stored(id)).permissionRequest, undefined);
	assertBuildDelivery(f.sessions.controlPermission(id));
});
