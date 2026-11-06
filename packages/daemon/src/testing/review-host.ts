/** Disposable real Review host for the hidden native Review journey.
 *
 * Real pieces: SessionManager.spawn creation-only standalone enrollment, managed jj workspaces, the
 * worker checkpoint capture, the retained snapshot store, missions.sqlite review requests and the real
 * daemon routes. The worker is the session-workspace FakeWorker: no provider, model turn or reviewer
 * ever runs. Review requests exist only after an explicit "suggest" setup command on stdin, which
 * posts the native suggestion directly to the daemon, not through the proxy the app uses. Fault
 * commands change in-memory chat metadata only; they are not a move or restore API.
 *
 * Controlled by JSON lines on stdin; replies are JSON lines on stdout. Other output is not JSON. */
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import type { DaemonHello, ReviewRequestSuggestion } from "@pilot/protocol";
import { GitHubSetupService } from "../github-setup.ts";
import { dispositionTarget } from "../human-reviews.ts";
import { MissionService } from "../mission-service.ts";
import { MissionStore } from "../missions.ts";
import { ModelCatalog } from "../models.ts";
import { createDaemonServer } from "../server.ts";
import { TerminalManager } from "../terminals.ts";
import { copyGitSeed } from "./git-seed.ts";
import { fixture, git, jj } from "./session-workspace.ts";

// The synthetic native client expects exactly this daemon identity.
const host = { hostId: "daemon", daemonId: "test-daemon", lineageId: "test-lineage" };
const hello: DaemonHello = {
	...host,
	daemonVersion: "review-host",
	protocolVersion: 1,
	minimumClientProtocolVersion: 1,
	platform: "darwin",
	arch: "arm64",
	capabilities: {
		powerManagement: false,
		systemSleepEvents: false,
		swiftUIArtifacts: false,
		coordinatorIsolation: true,
		independentExecution: true,
	},
};

type Command = {
	cmd: string;
	project?: "A" | "B";
	id?: string;
	title?: string;
	files?: Record<string, string>;
	message?: string;
	count?: number;
	change?: string;
	snapshotId?: string;
};

async function main() {
	const cleanups: (() => unknown)[] = [];
	// The shared fixture only registers teardown; it never runs tests itself.
	const t = { after: (fn: () => unknown) => void cleanups.push(fn) } as unknown as TestContext;
	const f = await fixture(t);
	// A second project with its own repository, so Review spans projects.
	const sourceB = join(f.root, "source-b");
	copyGitSeed(sourceB, { "notes.md": "base notes\n" });
	git(f.root, "init", "--quiet", "--bare", "-b", "main", join(f.root, "remote-b.git"));
	git(sourceB, "remote", "add", "origin", join(f.root, "remote-b.git"));
	git(sourceB, "push", "--quiet", "origin", "HEAD:main");
	jj(sourceB, "git", "init", "--colocate");
	const projectB = await f.projects.create({ path: sourceB });
	const projects = { A: f.project, B: projectB };
	const sessions = f.sessions;
	const store = new MissionStore(join(f.home, "missions.sqlite"));
	const service = new MissionService(store, sessions, f.projects);
	const terminals = new TerminalManager();
	const native = new GitHubSetupService(f.home, host, { userHome: f.home, env: {} });
	await native.status();
	const capability = JSON.parse(readFileSync(join(f.home, "github-app-capability"), "utf8")).token as string;
	const args: Parameters<typeof createDaemonServer> = [
		{ home: f.home, host: "127.0.0.1", port: 0 },
		sessions,
		f.projects,
		new ModelCatalog(f.home),
		terminals,
		{ store, service },
	];
	args[12] = hello;
	args[17] = native;
	const daemon = createDaemonServer(...args);
	daemon.listen(0, "127.0.0.1");
	await once(daemon, "listening");
	const api = `http://127.0.0.1:${(daemon.address() as AddressInfo).port}/api`;

	// The app reads only through this proxy, so its requests can be listed and the host can go offline.
	let log: { method: string; path: string }[] = [];
	// Fault only: the proxy answers the request list as a host without a request source would.
	let failRequests = false;
	const proxy: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const path = req.url ?? "/";
			log.push({ method: req.method ?? "", path });
			if (failRequests && path.startsWith("/api/review/requests")) {
				res.writeHead(503, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "Authoritative Review requests unavailable" }));
				return;
			}
			const headers: Record<string, string> = {};
			for (const name of ["content-type", "x-pilot-github-capability"]) {
				const value = req.headers[name];
				if (typeof value === "string") headers[name] = value;
			}
			const body = Buffer.concat(chunks);
			void fetch(`http://127.0.0.1:${(daemon.address() as AddressInfo).port}${path}`, {
				method: req.method,
				headers,
				body: req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(body),
			})
				.then(async (response) => {
					const text = await response.text();
					res.writeHead(response.status, {
						"content-type": response.headers.get("content-type") ?? "application/json",
					});
					res.end(text);
				})
				.catch(() => {
					res.writeHead(502);
					res.end();
				});
		});
	});
	proxy.listen(0, "127.0.0.1");
	await once(proxy, "listening");
	const port = (proxy.address() as AddressInfo).port;

	const meta = (id: string) => {
		// biome-ignore lint/complexity/useLiteralKeys: Fixture reads the live session metadata.
		const value = sessions["metas"].get(id);
		if (!value) throw new Error("Unknown chat");
		return value;
	};
	const spawn = async (project: "A" | "B", title: string) => {
		const created = await sessions.spawn({ projectId: projects[project].id, message: "Review host change" });
		// biome-ignore lint/complexity/useLiteralKeys: Await the real creation initializer, as the fixture does.
		await sessions["starting"].get(created.id);
		await sessions.stop(created.id);
		// biome-ignore lint/complexity/useLiteralKeys: Let title and metadata writes settle.
		await Promise.all([...sessions["titleTasks"], ...sessions["saving"].values()]);
		const m = meta(created.id);
		if (m.failure) throw new Error(m.failure);
		if (m.retainedScope?.version !== 2 || m.retainedScope.projectId !== projects[project].id)
			throw new Error("New standalone Build chat was not enrolled");
		await sessions.rename(created.id, title);
		return m;
	};
	const commit = (cwd: string, files: Record<string, string>, message: string) => {
		for (const [path, text] of Object.entries(files)) writeFileSync(join(cwd, path), text);
		jj(cwd, "commit", "-m", message);
		return jj(cwd, "log", "--no-graph", "-r", "@-", "-T", 'change_id ++ " " ++ commit_id').split(" ");
	};
	const checkpoint = async (id: string) => {
		// biome-ignore lint/complexity/useLiteralKeys: The same worker checkpoint lifecycle events run.
		await sessions["checkpointWorkerReview"](meta(id));
	};
	const direct = async (path: string, init?: RequestInit) => {
		const response = await fetch(`${api}/${path}`, init);
		return { status: response.status, body: (await response.json()) as unknown };
	};
	const requests = () => {
		const rows: [string, number, string, number][] = [];
		for (let after = 0; ; ) {
			const page = store.reviewRequests.page(after);
			for (const r of page.records) rows.push([r.requestId, r.revision, r.state, r.sequence]);
			if (page.next === null) return rows;
			after = page.next;
		}
	};
	const moved = new Map<string, string>();
	const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
	emit({
		port,
		home: f.home,
		projects: {
			A: { id: projects.A.id, path: projects.A.path },
			B: { id: projects.B.id, path: projects.B.path },
		},
	});
	for await (const line of createInterface({ input: process.stdin })) {
		const c = JSON.parse(line) as Command;
		try {
			switch (c.cmd) {
				case "chat": {
					const m = await spawn(c.project ?? "A", c.title ?? "Review host chat");
					emit({ ok: c.cmd, id: m.id, cwd: m.cwd });
					break;
				}
				case "commit": {
					const [change, commitId] = commit(meta(c.id!).cwd, c.files ?? {}, c.message ?? "Change");
					emit({ ok: c.cmd, change, commit: commitId });
					break;
				}
				case "commits": {
					// Many separate changes, each with its own file.
					const cwd = meta(c.id!).cwd;
					for (let i = 1; i <= (c.count ?? 1); i++)
						commit(cwd, { [`bulk-${i}.txt`]: `bulk change ${i}\n` }, `Bulk change ${i}`);
					emit({ ok: c.cmd });
					break;
				}
				case "describe": {
					jj(meta(c.id!).cwd, "describe", "-r", c.change!, "-m", c.message ?? "Revised");
					emit({ ok: c.cmd });
					break;
				}
				case "write": {
					// A live workspace edit that no checkpoint captures.
					for (const [path, text] of Object.entries(c.files ?? {}))
						writeFileSync(join(meta(c.id!).cwd, path), text);
					emit({ ok: c.cmd });
					break;
				}
				case "fail-requests":
				case "restore-requests":
					failRequests = c.cmd === "fail-requests";
					emit({ ok: c.cmd });
					break;
				case "checkpoint":
					// One worker checkpoint saves a limited batch; "count" repeats it until nothing waits.
					for (let i = 0; i < (c.count ?? 1); i++) {
						await checkpoint(c.id!);
						const page = (await direct(`sessions/${c.id}/review?after=0`)).body as {
							capture?: { pending: number };
						};
						if (!page.capture?.pending) break;
					}
					emit({ ok: c.cmd });
					break;
				case "comparisons": {
					const all: unknown[] = [];
					for (let after = 0; ; ) {
						const page = (await direct(`sessions/${c.id}/review?after=${after}`)).body as {
							comparisons: { sequence: number }[];
							next: number | null;
						};
						all.push(...page.comparisons);
						if (page.next === null) break;
						after = page.next;
					}
					emit({ ok: c.cmd, comparisons: all });
					break;
				}
				case "suggest": {
					// Explicit setup only: the real native suggestion route, sent by this fixture.
					const m = meta(c.id!);
					const reader = sessions.nativeReviewReader(m.id, undefined, m.projectId!, () => {}, true);
					const target = dispositionTarget(m.projectId!, await reader.get(c.snapshotId!));
					const suggestion: ReviewRequestSuggestion = {
						operationId: crypto.randomUUID(),
						target,
						title: c.title ?? "Please review",
						reason: "Fixture setup suggestion",
						replacesRequestId: null,
						replacesExpectedRevision: null,
					};
					const r = await direct("review/requests/suggest", {
						method: "POST",
						headers: { "content-type": "application/json", "x-pilot-github-capability": capability },
						body: JSON.stringify(suggestion),
					});
					if (r.status !== 200) throw new Error(`suggest ${r.status} ${JSON.stringify(r.body)}`);
					emit({ ok: c.cmd, requestId: (r.body as { requestId: string }).requestId });
					break;
				}
				case "withdraw": {
					const row = store.reviewRequests.get(c.id!)!;
					const r = await direct("review/requests/withdraw", {
						method: "POST",
						headers: { "content-type": "application/json", "x-pilot-github-capability": capability },
						body: JSON.stringify({
							operationId: crypto.randomUUID(),
							requestId: row.requestId,
							expectedRevision: row.revision,
							reason: "Fixture setup withdrawal",
						}),
					});
					if (r.status !== 200) throw new Error(`withdraw ${r.status}`);
					emit({ ok: c.cmd });
					break;
				}
				case "sessions":
					emit({ ok: c.cmd, sessions: (await direct("sessions")).body });
					break;
				case "requests":
					emit({ ok: c.cmd, requests: requests() });
					break;
				case "move": {
					// In-memory current metadata fault only: the chat now names the other project.
					const m = meta(c.id!);
					moved.set(m.id, m.projectId!);
					m.projectId = projects[c.project ?? "B"].id;
					emit({ ok: c.cmd });
					break;
				}
				case "unmove": {
					const m = meta(c.id!);
					m.projectId = moved.get(m.id) ?? m.projectId;
					moved.delete(m.id);
					emit({ ok: c.cmd });
					break;
				}
				case "offline":
					await new Promise<void>((resolve) => {
						proxy.close(() => resolve());
						proxy.closeAllConnections();
					});
					emit({ ok: c.cmd });
					break;
				case "online":
					proxy.listen(port, "127.0.0.1");
					await once(proxy, "listening");
					emit({ ok: c.cmd });
					break;
				case "log":
					emit({ ok: c.cmd, requests: log });
					log = [];
					break;
				case "close": {
					const failures: string[] = [];
					const step = async (name: string, run: () => unknown) => {
						try {
							await run();
						} catch (error) {
							failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
						}
					};
					await step("proxy", () => {
						if (proxy.listening) proxy.close();
						proxy.closeAllConnections();
					});
					await step("daemon", async () => {
						const closed = new Promise<void>((resolve) => daemon.close(() => resolve()));
						daemon.closeAllConnections();
						await closed;
					});
					await step("notices", () => service.notices.stop());
					await step("terminals", () => terminals.shutdown());
					await step("native", () => native.close());
					// Chats stop before the store their missions service reads closes.
					await step("chats", () => sessions.shutdown());
					await step("store", async () => {
						await store.durable();
						store.close();
					});
					await step("sessions", () =>
						cleanups.reverse().reduce((p, run) => p.then(run), Promise.resolve<unknown>(undefined)),
					);
					emit({ ok: c.cmd, failures });
					return;
				}
				default:
					throw new Error(`Unknown command ${c.cmd}`);
			}
		} catch (error) {
			emit({ ok: c.cmd, error: error instanceof Error ? error.message : String(error) });
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
	// Fixture-owned handles may outlive teardown; the native probe waits for this exit.
	process.exit(0);
}
