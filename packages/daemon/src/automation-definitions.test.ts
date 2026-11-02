import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Automation, ProjectRequest } from "@pilot/protocol";
import { AUTOMATION_FOLLOW_UP_ATTEMPT_LIMIT, validateAutomationItems } from "./automation-definitions.ts";
import { daemonHello } from "./hello.ts";
import { AutomationsRevisionConflict, ProjectStore } from "./projects.ts";

const setup: Automation = {
	id: "install",
	name: "Install dependencies",
	enabled: true,
	on: ["workspace.created", "workspace.restored"],
	action: { type: "shell", run: { argv: ["pnpm", "install"] } },
};

test("validates ordered setup, check and continue definitions with detached values", () => {
	const items = [
		setup,
		{
			id: "lint",
			name: "Lint",
			enabled: false,
			on: ["run.finished"],
			when: { filesChanged: { paths: ["packages/**", "*.ts"] } },
			action: {
				type: "shell",
				run: { shell: "pnpm lint" },
				onFailure: "followUp",
				env: { CI: "1" },
				cwd: "packages",
				timeoutMs: 1000,
			},
		},
		{
			id: "continue",
			name: "Continue",
			enabled: true,
			on: ["run.finished"],
			when: { openTodos: true },
			action: { type: "followUp", message: "Continue" },
		},
	];
	assert.deepEqual(validateAutomationItems(items), items);
	const copy = validateAutomationItems(items);
	copy[0]!.name = "Changed";
	assert.equal(setup.name, "Install dependencies");
	assert.equal(AUTOMATION_FOLLOW_UP_ATTEMPT_LIMIT, 3);
});

test("invalid definitions identify the hook and field, including disabled hooks", () => {
	for (const [patch, field] of [
		[{ id: "BAD" }, "id"],
		[{ name: "two\nlines" }, "name"],
		[{ enabled: "yes" }, "enabled"],
		[{ on: [] }, "on"],
		[{ on: ["chat.archived"] }, "on"],
		[{ on: ["workspace.created", "workspace.created"] }, "on"],
		[{ on: ["workspace.created", "run.finished"] }, "run.finished"],
		[{ when: { openTodos: true } }, "when"],
		[{ action: { type: "shell", run: { shell: "true" }, timeoutMs: 1 } }, "timeoutMs"],
		[{ action: { type: "shell", run: { shell: "true" }, onFailure: "followUp" } }, "onFailure"],
		[{ action: { type: "shell", run: { shell: "true", argv: ["true"] } } }, "run"],
		[{ action: { type: "shell", run: { argv: [] } } }, "argv"],
		[{ action: { type: "shell", run: { shell: "x\0y" } } }, "shell"],
		[{ action: { type: "shell", run: { shell: "true" }, cwd: "../out" } }, "cwd"],
		[{ action: { type: "shell", run: { shell: "true" }, requires: [] } }, "requires"],
		[{ action: { type: "followUp" } }, "followUp"],
		[{ unknown: true }, "unknown"],
	] as const)
		assert.throws(
			() => validateAutomationItems([{ ...setup, ...patch }]),
			(error: Error) => error.message.includes(field),
		);
	for (const key of ["PATH", "HOME", "PILOT_X", "API_KEY", "MY_TOKEN", "SECRET", "PASSWORD", "CREDENTIALS", "lower"]) {
		assert.throws(
			() => validateAutomationItems([{ ...setup, action: { ...setup.action, env: { [key]: "x" } } }]),
			/install: env/,
		);
	}
	assert.throws(() => validateAutomationItems([setup, setup]), /install: id/);
	assert.throws(() => validateAutomationItems(Array(33).fill(setup)), /items/);
	assert.throws(
		() => validateAutomationItems([{ ...setup, on: ["run.finished"], action: { type: "followUp" }, when: {} }]),
		/condition/,
	);
	assert.throws(
		() => validateAutomationItems([{ ...setup, on: ["run.finished"], when: { filesChanged: { paths: ["../*"] } } }]),
		/filesChanged.paths/,
	);
});

test("project hook saves are revision checked, hot-reloaded and preserved across restart", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-hook-definitions-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const store = new ProjectStore(home);
	await store.load();
	const project = await store.create({ path: home });
	let changes = 0;
	const dispose = store.onChange(() => changes++);
	const first = await store.updateAutomations(project.id, { expectedRevision: 0, items: [setup] });
	assert.equal(first.revision, 1);
	const snapshot = store.enabledAutomations(project.id, "workspace.created");
	assert.deepEqual(snapshot, first);
	assert.deepEqual(store.enabledAutomations(project.id, "run.finished").items, []);
	await store.updateAutomations(project.id, { expectedRevision: 1, items: [{ ...setup, enabled: false }] });
	assert.equal(changes, 2);
	assert.equal(snapshot.items[0]!.enabled, true, "running work keeps its snapshot");
	assert.deepEqual(store.enabledAutomations(project.id, "workspace.created").items, []);
	await assert.rejects(
		store.updateAutomations(project.id, { expectedRevision: 1, items: [] }),
		(error: unknown) => error instanceof AutomationsRevisionConflict && error.current.revision === 2,
	);
	await assert.rejects(
		store.updateAutomations(project.id, { expectedRevision: 2, items: [{ ...setup, action: {} }] }),
		/action.type/,
	);
	assert.equal(changes, 2, "invalid and stale writes do not notify");
	await assert.rejects(
		store.create({ path: home, automations: first } as ProjectRequest),
		/native automations endpoint/,
	);
	await assert.rejects(
		store.update(project.id, { automations: first } as Partial<ProjectRequest>),
		/native automations endpoint/,
	);
	const reopened = new ProjectStore(home);
	await reopened.load();
	assert.deepEqual(reopened.require(project.id).automations, store.require(project.id).automations);
	dispose();
});

test("invalid saved definitions stay on disk with an error and cannot run", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-invalid-hooks-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const raw = { revision: 7, items: [{ ...setup, future: true }] };
	await writeFile(
		join(home, "projects.json"),
		JSON.stringify([{ id: "p", name: "Project", path: home, createdAt: 1, automations: raw }]),
	);
	const store = new ProjectStore(home);
	await store.load();
	assert.match(store.require("p").automations!.error!, /install: unknown field future/);
	assert.deepEqual(store.enabledAutomations("p", "workspace.created"), { revision: 7, items: [] });
	await store.update("p", { name: "Renamed" });
	assert.deepEqual(JSON.parse(await readFile(join(home, "projects.json"), "utf8"))[0].automations, raw);
	await store.updateAutomations("p", { expectedRevision: 7, items: [setup] });
	assert.equal(store.require("p").automations?.error, undefined);
	assert.equal(store.require("p").automations?.revision, 8);
});

test("hook capability is absent from the static handshake", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-hook-hello-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const capabilities = {
		powerManagement: false,
		systemSleepEvents: false,
		swiftUIArtifacts: false,
		coordinatorIsolation: false,
		independentExecution: true,
	};
	assert.equal((await daemonHello(home, capabilities, {})).capabilities.automations, undefined);
});
