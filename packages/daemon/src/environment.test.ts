import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EnvironmentService, ignoredFiles } from "./environment.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";
import { run } from "./workspaces.ts";

test("discovery runs in a worker, shares concurrent reads and reports unknown projects", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-environment-service-"));
	const service = new EnvironmentService(new ProjectStore(home));
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
	const environment = new EnvironmentService(projects);
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
	assert.equal((await fetch(urls[1]!.replace(project.id, "missing") + "/discovery")).status, 404);
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
