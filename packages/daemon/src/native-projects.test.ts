import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DurableOperation } from "@pilot/protocol";
import { GitHubImportService } from "./github-import.ts";
import { GitHubSetupService } from "./github-setup.ts";
import { nativeIntakeFixture } from "./native-intake.fixture.ts";
import { NativeProjects, PROJECT_ACTION } from "./native-projects.ts";
import { OperationJournal, payloadHash } from "./operation-journal.ts";
import { ProjectStore } from "./projects.ts";

test("native local project HTTP requires app capability, previews passively and binds an idempotent receipt", async (t) => {
	const f = await nativeIntakeFixture({ projectSetup: true });
	t.after(() => f.close());
	const path = join(f.home, "new-source");
	await mkdir(path);
	const headers = { "x-pilot-github-capability": f.capability, "content-type": "application/json" };
	const denied = await fetch(`${f.root}/api/native-projects/setup`);
	assert.equal(denied.status, 403);
	await denied.arrayBuffer();
	const shown = await fetch(`${f.root}/api/native-projects/setup`, { headers });
	assert.equal(shown.status, 200);
	assert.equal((await shown.json()).projects.length, 2);
	const preview = await fetch(`${f.root}/api/native-projects/preview`, {
		method: "POST",
		headers,
		body: JSON.stringify({ path }),
	});
	assert.equal(preview.status, 200);
	const p = await preview.json();
	assert.equal(p.copy, "folder");
	assert.equal(f.projects.list().length, 2);
	const payload = JSON.stringify({ purpose: PROJECT_ACTION, action: "add", path: p.path, digest: p.digest });
	const op: DurableOperation = {
		schemaVersion: 1,
		operationId: randomUUID(),
		producerId: randomUUID(),
		sequence: 1,
		origin: { ...f.host, hostId: "local" },
		destination: f.host,
		kind: PROJECT_ACTION,
		targetId: "projects",
		bindingId: payloadHash(payload),
		bindingGeneration: 1,
		payload,
		payloadHash: payloadHash(payload),
	};
	const send = async (lookup = false) => {
		const r = await fetch(`${f.root}/api/operations${lookup ? "/receipt" : ""}`, {
			method: "POST",
			headers,
			body: JSON.stringify(op),
		});
		assert.equal(r.status, 200);
		return r.json();
	};
	const r = await send();
	assert.equal(r.state, "accepted");
	assert.deepEqual(await send(true), r);
	assert.deepEqual(await send(), r);
	assert.equal(f.projects.list().length, 3);
	assert.equal(f.stats().sessions, 0);
	assert.equal(f.stats().external, 0);
});

test("native project actions bind the displayed source, preserve exact receipts and never replay entered effects", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "native-projects-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const host = { hostId: "daemon", daemonId: "d", lineageId: "l" };
	const home = join(root, "data"),
		path = join(root, "source");
	await mkdir(path);
	const projects = new ProjectStore(home);
	await projects.load();
	const setup = new GitHubSetupService(home, host, {
		userHome: root,
		env: {},
		command: async () => {
			throw new Error("No external actions expected");
		},
	});
	const imports = new GitHubImportService(setup, projects);
	t.after(() => setup.close());
	const journal = new OperationJournal(join(home, "operations"), host);
	const service = new NativeProjects({ projects, setup, imports, journal });
	assert.equal((await service.read()).projects.length, 0);
	const preview = await service.preview(path);
	const payload = JSON.stringify({
		purpose: PROJECT_ACTION,
		action: "add",
		path: preview.path,
		digest: preview.digest,
	});
	const op: DurableOperation = {
		schemaVersion: 1,
		operationId: randomUUID(),
		producerId: "app",
		sequence: 1,
		origin: { ...host, hostId: "local" },
		destination: host,
		kind: PROJECT_ACTION,
		targetId: "projects",
		bindingId: payloadHash(payload),
		bindingGeneration: 1,
		payload,
		payloadHash: payloadHash(payload),
	};
	const receipt = await journal.execute(op, (o, e) => service.admit(o, e.firstEntry));
	assert.equal(receipt.state, "accepted");
	assert.equal(projects.list().length, 1);
	const duplicate = { ...op, operationId: randomUUID(), producerId: randomUUID() };
	assert.equal(
		(await journal.execute(duplicate, (o, e) => service.admit(o, e.firstEntry))).state,
		"rejected",
		"known pre-admission duplicate is not an uncertain write",
	);
	await projects.updateAutomations(projects.list()[0]!.id, {
		expectedRevision: 0,
		items: [
			{
				id: "setup",
				name: "Install dependencies",
				enabled: true,
				on: ["workspace.created"],
				action: {
					type: "shell",
					run: { shell: "echo fixture-private-command" },
					env: { CONFIG_VALUE: "fixture-private-token" },
				},
			},
		],
	});
	const visible = await service.read();
	assert.deepEqual(visible.projects[0]!.setup, [{ id: "setup", name: "Install dependencies", enabled: true }]);
	assert.ok(
		!JSON.stringify(visible).includes("fixture-private"),
		"setup labels do not disclose commands or environment secrets to the VM",
	);
	assert.ok(
		!JSON.stringify(await service.recover(op)).includes("fixture-private"),
		"recovered registration receipts do not expose later project configuration",
	);
	// Recover a lost outer acknowledgement only from the exact saved registration receipt.
	const addedPath = join(root, "another");
	await mkdir(addedPath);
	const shown = await projects.previewLocal(addedPath);
	const addedPayload = JSON.stringify({
		purpose: PROJECT_ACTION,
		action: "add",
		path: shown.path,
		digest: shown.digest,
	});
	const lostAdd = {
		...op,
		operationId: randomUUID(),
		producerId: randomUUID(),
		payload: addedPayload,
		payloadHash: payloadHash(addedPayload),
	};
	await journal.reserve(lostAdd);
	await projects.createLocal(shown.path, shown.digest, {
		operationId: lostAdd.operationId,
		payloadHash: lostAdd.payloadHash,
	});
	assert.equal((await journal.execute(lostAdd, (o) => service.recover(o))).state, "accepted");
	assert.equal(projects.list().length, 2);
	await assert.rejects(service.recover({ ...lostAdd, operationId: randomUUID() }), /unknown/);
	assert.equal(projects.list()[0]!.sourceCopy, "folder");
	assert.deepEqual(await journal.lookup(op), receipt);
	assert.deepEqual(await journal.execute(op, (o, e) => service.admit(o, e.firstEntry)), receipt);
	assert.equal(projects.list().length, 2);
	// A durable reservation with no terminal receipt is uncertain after restart, never permission to send.
	const pending = { ...op, operationId: randomUUID(), producerId: randomUUID() };
	await journal.reserve(pending);
	const reopened = new OperationJournal(join(home, "operations"), host);
	assert.equal((await reopened.execute(pending, (o) => service.admit(o, false))).state, "pending");
	assert.equal(projects.list().length, 2);
	// A saved import-start admission settles only that start, even if cloning later fails.
	const importPreview = await imports.preview("https://github.com/test/repo", "imported");
	const importPayload = JSON.stringify({
		purpose: PROJECT_ACTION,
		action: "import",
		url: "https://github.com/test/repo",
		destination: importPreview.resolvedDestination,
	});
	const lostImport = {
		...op,
		operationId: randomUUID(),
		producerId: randomUUID(),
		payload: importPayload,
		payloadHash: payloadHash(importPayload),
	};
	await journal.reserve(lostImport);
	await imports.start({
		id: lostImport.operationId,
		url: "https://github.com/test/repo",
		destination: importPreview.resolvedDestination,
	});
	await imports.close();
	const loadedImports = new GitHubImportService(setup, projects);
	const recovered = new NativeProjects({ projects, setup, imports: loadedImports, journal });
	const startReceipt = await journal.execute(lostImport, (o) => recovered.recover(o));
	assert.equal(startReceipt.state, "accepted");
	assert.notEqual((await loadedImports.acceptedStart(lostImport.operationId))?.phase, "done");
	await assert.rejects(recovered.recover({ ...lostImport, operationId: randomUUID() }), /unknown/);
	assert.equal(projects.list().length, 2);
	await loadedImports.close();
});

test("native link and unlink change one project's linked list and lookups never replay", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "native-projects-link-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const host = { hostId: "daemon", daemonId: "d", lineageId: "l" };
	const home = join(root, "data");
	const projects = new ProjectStore(home);
	await projects.load();
	await mkdir(join(root, "app"));
	await mkdir(join(root, "lib"));
	const app = await projects.create({ path: join(root, "app") });
	const lib = await projects.create({ path: join(root, "lib") });
	const setup = new GitHubSetupService(home, host, {
		userHome: root,
		env: {},
		command: async () => {
			throw new Error("No external actions expected");
		},
	});
	t.after(() => setup.close());
	const journal = new OperationJournal(join(home, "operations"), host);
	const service = new NativeProjects({ projects, setup, imports: new GitHubImportService(setup, projects), journal });
	let sequence = 0;
	const operation = (action: string, fields: Record<string, string>): DurableOperation => {
		const payload = JSON.stringify({ purpose: PROJECT_ACTION, action, ...fields });
		return {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: "app",
			sequence: ++sequence,
			origin: { ...host, hostId: "local" },
			destination: host,
			kind: PROJECT_ACTION,
			targetId: "projects",
			bindingId: payloadHash(payload),
			bindingGeneration: 1,
			payload,
			payloadHash: payloadHash(payload),
		};
	};
	const link = operation("link", { project: app.id, linked: lib.id });
	assert.equal((await journal.execute(link, (o, e) => service.admit(o, e.firstEntry))).state, "accepted");
	assert.deepEqual((await service.read()).projects.find((p) => p.id === app.id)?.linked, [lib.id]);
	assert.deepEqual(await service.recover(link), { project: { id: app.id, linked: [lib.id] } });
	const self = operation("link", { project: app.id, linked: app.id });
	assert.equal((await journal.execute(self, (o, e) => service.admit(o, e.firstEntry))).state, "rejected");
	const unlink = operation("unlink", { project: app.id, linked: lib.id });
	assert.equal((await journal.execute(unlink, (o, e) => service.admit(o, e.firstEntry))).state, "accepted");
	assert.equal(projects.require(app.id).linkedProjects, undefined);
	await assert.rejects(service.recover(link), /unknown/, "a lookup reports the current list, never relinks");
});
