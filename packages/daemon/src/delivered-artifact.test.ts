import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { DeliveredArtifact, DeliveredArtifactRequest, DeliveredWork } from "@pilot/protocol";
import { nativeIntakeFixture } from "./native-intake.fixture.ts";

async function fixture(t: TestContext) {
	const f = await nativeIntakeFixture();
	t.after(() => f.close());
	const worker = await f.sessions.spawnDurable(
		{ projectId: f.project.id, mode: "build", model: "fake/model", message: "Synthetic only" },
		randomUUID(),
		randomUUID(),
	);
	const mission = f.store.create({ projectId: f.project.id, title: "Synthetic output" });
	f.store.join(worker.id, mission.id);
	const task = f.store.addTask(mission.id, { title: "Captured result", sessionId: worker.id });
	const artifactId = randomUUID();
	const directory = join(f.home, "sessions", worker.id, "artifacts", artifactId);
	await mkdir(directory, { recursive: true });
	const source = "() => { throw new Error('must never execute'); } // é😀\r\n";
	const artifact = {
		id: artifactId,
		sessionId: worker.id,
		projectId: f.project.id,
		kind: "visual",
		title: "Captured result",
		revision: 1,
		createdAt: 1,
		updatedAt: 2,
		source,
		data: { privateCallback: "not disclosed" },
		html: "never disclose this document",
		libraries: [],
		visual: { api: 1, engine: "saved" },
	};
	const bytes = Buffer.from(`\uFEFF${JSON.stringify(artifact, null, 2).replaceAll("\n", "\r\n")}\r\n`);
	await writeFile(join(directory, "1.json"), bytes);
	await writeFile(join(directory, "2.json"), JSON.stringify({ ...artifact, revision: 2, source: "newer source" }));
	await writeFile(join(directory, "latest.json"), JSON.stringify({ ...artifact, revision: 2 }));
	f.store.linkArtifact(mission.id, {
		taskId: task.id,
		sessionId: worker.id,
		artifactId,
		title: artifact.title,
		kind: "visual",
		revision: 1,
	});
	f.store.join("completion-lead", mission.id);
	f.store.update(mission.id, { coordinatorSessionId: "completion-lead" });
	f.store.completeTask(mission.id, task.id, "completion-lead", {
		commit: "a".repeat(40),
		checks: "Synthetic",
		issues: "",
	});
	const path = `/api/projects/${f.project.id}/missions/${mission.id}/tasks/${task.id}/delivered-work`;
	const headers = { "x-pilot-github-capability": f.capability };
	const page = (await (await fetch(f.root + path, { headers })).json()) as DeliveredWork;
	const request: DeliveredArtifactRequest = {
		subject: page.subject,
		targetId: page.targetId,
		deliveryId: page.deliveryId!,
		ownerSessionId: worker.id,
		sourceSessionId: worker.id,
		artifactId,
		revision: 1,
	};
	const read = async (r = request, token = f.capability, extra = "", route = path) => {
		const { subject: _subject, ...fields } = r;
		const query = new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v ?? "")]));
		return fetch(`${f.root}${route}/artifact?${query}${extra}`, { headers: { "x-pilot-github-capability": token } });
	};
	return { ...f, worker, mission, task, directory, artifact, bytes, request, read, page, path, headers };
}

test("delivered artifact reads exact captured revision without execution, preview preparation or assessment", async (t) => {
	const f = await fixture(t);
	const before = f.stats();
	const response = await f.read();
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store");
	const value = (await response.json()) as DeliveredArtifact;
	assert.equal(value.rendering, "unsupported");
	assert.deepEqual(value.reference, f.request);
	assert.deepEqual(value.content, {
		state: "text",
		source: f.artifact.source,
		containerSha256: createHash("sha256").update(f.bytes).digest("hex"),
		containerBytes: f.bytes.length,
	});
	assert.equal("html" in value, false);
	assert.equal("data" in value, false);
	assert.deepEqual(await readFile(join(f.directory, "1.json")), f.bytes);
	const current = await (await fetch(f.root + f.path, { headers: f.headers })).json();
	assert.equal(current.verification, null);
	assert.equal(current.deliveryId, f.page.deliveryId);
	assert.deepEqual(f.stats(), before);
});

test("delivery artifact refuses missing pins, latest fallback, stale scope, wrong source and native capability", async (t) => {
	const f = await fixture(t);
	assert.notEqual((await f.read(f.request, "bad-token")).status, 200);
	for (const patch of [
		{ revision: 0 },
		{ revision: 2 },
		{ sourceSessionId: randomUUID() },
		{ artifactId: randomUUID() },
		{ artifactId: "../../latest" },
		{ ownerSessionId: randomUUID() },
		{ targetId: "f".repeat(64) },
		{ deliveryId: "f".repeat(64) },
	]) {
		assert.notEqual((await f.read({ ...f.request, ...patch })).status, 200, JSON.stringify(patch));
	}
	assert.notEqual((await f.read(f.request, f.capability, "&revision=1")).status, 200);
	assert.notEqual((await f.read(f.request, f.capability, "&path=/tmp/a")).status, 200);
	for (const route of [
		f.path.replace(f.project.id, f.other.id),
		f.path.replace(f.mission.id, randomUUID()),
		f.path.replace(f.task.id, randomUUID()),
	]) {
		assert.notEqual((await f.read(f.request, f.capability, "", route)).status, 200, route);
	}
	f.store.updateTask(f.mission.id, f.task.id, { body: "New delivery definition" });
	assert.equal((await f.read()).status, 409);
});

test("delivery artifact checks current source membership even when delivery pins are unchanged", async (t) => {
	const f = await fixture(t);
	f.store.leave(f.worker.id);
	assert.notEqual((await f.read()).status, 200);
});

test("delivery artifact fences source membership ABA during captured-byte I/O", async (t) => {
	const f = await fixture(t);
	const read = f.sessions.readCapturedArtifactRevision.bind(f.sessions);
	t.mock.method(f.sessions, "readCapturedArtifactRevision", async (...args: Parameters<typeof read>) => {
		const result = await read(...args);
		f.store.leave(f.worker.id);
		f.store.join(f.worker.id, f.mission.id);
		return result;
	});
	assert.equal((await f.read()).status, 409);
});

test("removed task artifact link refuses before any captured source read", async (t) => {
	const f = await fixture(t);
	const read = t.mock.method(f.sessions, "readCapturedArtifactRevision");
	f.store.unlinkArtifact(f.mission.id, f.artifact.id, undefined, f.task.id);
	assert.equal((await f.read()).status, 409);
	assert.equal(read.mock.callCount(), 0);
});

test("captured file identity mismatches cannot masquerade as the linked revision", async (t) => {
	const f = await fixture(t);
	for (const patch of [
		{ revision: 2 },
		{ projectId: f.other.id },
		{ sessionId: randomUUID() },
		{ id: randomUUID() },
	]) {
		await writeFile(join(f.directory, "1.json"), JSON.stringify({ ...f.artifact, ...patch }));
		assert.deepEqual((await (await f.read()).json()).content, { state: "unavailable", reason: "invalid" });
	}
});

test("missing, oversized, redacted and corrupt captured revisions never fall back or disclose partial source", async (t) => {
	const f = await fixture(t);
	const file = join(f.directory, "1.json");
	await rename(file, join(f.directory, "saved.json"));
	assert.deepEqual((await (await f.read()).json()).content, { state: "unavailable", reason: "missing" });
	await writeFile(file, " ".repeat(1024 * 1024 + 1));
	assert.deepEqual((await (await f.read()).json()).content, { state: "unavailable", reason: "oversize" });
	await writeFile(file, JSON.stringify({ ...f.artifact, source: "a".repeat(512 * 1024 + 1) }));
	assert.deepEqual((await (await f.read()).json()).content, { state: "unavailable", reason: "oversize" });
	for (const source of ["password=synthetic-secret", `show(${f.capability})`]) {
		await writeFile(file, JSON.stringify({ ...f.artifact, source }));
		assert.deepEqual((await (await f.read()).json()).content, { state: "unavailable", reason: "redacted" });
	}
	await writeFile(file, "invalid JSON contains private text");
	assert.deepEqual((await (await f.read()).json()).content, { state: "unavailable", reason: "invalid" });
});

for (const kind of ["html", "react", "swiftui", "shader", "visual", "image"] as const) {
	test(`saved ${kind} is inert text or honestly unavailable, never a rendered preview`, async (t) => {
		const f = await fixture(t);
		f.store.linkArtifact(f.mission.id, {
			taskId: f.task.id,
			sessionId: f.worker.id,
			artifactId: f.artifact.id,
			title: f.artifact.title,
			kind,
			revision: 1,
		});
		await writeFile(join(f.directory, "1.json"), JSON.stringify({ ...f.artifact, kind }));
		const value = await (await f.read()).json();
		assert.equal(value.rendering, "unsupported");
		assert.equal(value.metadata.kind, kind);
		assert.equal(value.content.state, kind === "image" ? "unavailable" : "text");
	});
}
