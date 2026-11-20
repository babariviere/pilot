import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "@pilot/artifacts";
import { metadataSearchLimits, searchProjectMetadata } from "./metadata-search.ts";
import { nativePlanningFixture } from "./native-mission-planning.fixture.ts";

type Fixture = Awaited<ReturnType<typeof nativePlanningFixture>>;

function request(f: Fixture, suffix: string, projectId = f.project.id, capability = f.capability, method = "GET") {
	return fetch(`${f.root}/api/projects/${projectId}/metadata-search${suffix}`, {
		method,
		headers: { "x-pilot-github-capability": capability },
	});
}

async function seedChat(f: Fixture, title: string, projectId: string, updatedAt: number, archivedAt?: number) {
	const id = randomUUID();
	const directory = join(f.home, "sessions", id);
	await mkdir(directory, { recursive: true });
	const meta = JSON.stringify({ id, title, projectId, cwd: f.home, createdAt: 1, updatedAt, archivedAt });
	const path = join(directory, "meta.json");
	await writeFile(path, meta);
	return { id, directory, path, meta };
}

async function seedPointer(directory: string, summary: Record<string, unknown>, id: string = randomUUID()) {
	const target = join(directory, "artifacts", id);
	await mkdir(target, { recursive: true });
	const value = JSON.stringify({ ...summary, id });
	await writeFile(join(target, "latest.json"), value);
	return { id, target, value };
}

test("metadata search returns minimal, exact-project title hits and pinned output revisions", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const path = join(f.home, "other");
	await mkdir(path);
	const other = await f.projects.create({ path });
	const mission = f.store.create({ projectId: f.project.id, title: "Release checklist", goal: "body-only" });
	const foreignMission = f.store.create({ projectId: other.id, title: "Release checklist" });
	const chat = await seedChat(f, "Release checklist chat", f.project.id, 2, 3);
	const foreignChat = await seedChat(f, "Release checklist other chat", other.id, 5);
	const wrongOwner = await seedChat(f, "Release checklist wrong owner", other.id, 6);
	f.store.join(chat.id, mission.id);
	f.store.join(foreignChat.id, foreignMission.id);
	f.store.join(wrongOwner.id, mission.id);
	const link = {
		sessionId: chat.id,
		artifactId: randomUUID(),
		kind: "image" as const,
		title: "Final checklist for release",
		revision: 2,
	};
	const task = f.store.addTask(mission.id, { title: "Release task" });
	f.store.linkArtifact(mission.id, { ...link, taskId: task.id, revision: 1 });
	const pinned = f.store.linkArtifact(mission.id, link);
	const unpinned = f.store.linkArtifact(mission.id, {
		...link,
		artifactId: randomUUID(),
		revision: undefined,
		title: "Unpinned link label",
	});
	f.store.linkArtifact(mission.id, { ...link, artifactId: randomUUID(), sessionId: wrongOwner.id });
	f.store.linkArtifact(foreignMission.id, { ...link, artifactId: randomUUID(), sessionId: foreignChat.id });
	f.store.linkArtifact(mission.id, { ...link, artifactId: randomUUID(), title: `Release checklist ${f.capability}` });
	const pointer = {
		projectId: f.project.id,
		sessionId: chat.id,
		kind: "image",
		title: "Renamed checklist for release",
		revision: 3,
		createdAt: 1,
		updatedAt: 3,
		ignored: "body-only",
	};
	// The committed latest metadata does not replace the older saved pin or its title.
	const out = await seedPointer(chat.directory, pointer, pinned.artifactId);
	await seedPointer(chat.directory, { ...pointer, title: "Release checklist unpinned" }, unpinned.artifactId);
	await seedPointer(chat.directory, { ...pointer, title: `Release checklist ${f.capability}` });
	await seedPointer(foreignChat.directory, { ...pointer, sessionId: foreignChat.id });
	await f.sessions.load();
	t.mock.method(f.sessions, "list", () => assert.fail("must not build session summaries"));
	t.mock.method(f.sessions, "projectArtifacts", () => assert.fail("must not fan out across the project"));
	t.mock.method(f.sessions, "artifacts", () => assert.fail("must not read artifact pointers"));
	t.mock.method(f.sessions, "artifact", () => assert.fail("must not load artifact bodies"));
	t.mock.method(f.sessions, "readCapturedArtifactRevision", () => assert.fail("must not load revisions"));
	t.mock.method(f.store, "list", () => assert.fail("must not hydrate missions"));

	const res = await request(f, "?q=%20rELeAse%20CHECKLIST%20");
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("cache-control"), "no-store");
	assert.deepEqual(await res.json(), {
		projectId: f.project.id,
		items: [
			{ kind: "mission", id: mission.id, title: "Release checklist" },
			{ kind: "chat", id: chat.id, title: "Release checklist chat" },
			{
				kind: "output",
				artifactKind: "image",
				artifactId: unpinned.artifactId,
				sessionId: chat.id,
				title: "Release checklist unpinned",
				revision: 3,
				updatedAt: 3,
			},
			{
				kind: "output",
				artifactKind: "image",
				artifactId: pinned.artifactId,
				sessionId: chat.id,
				title: "Final checklist for release",
				revision: 2,
				updatedAt: pinned.linkedAt,
			},
		],
		more: false,
		partial: false,
		nextCursor: null,
	});
	for (const query of ["body-only", "renamed", "link%20label"]) {
		assert.deepEqual(await (await request(f, `?q=${query}`)).json(), {
			projectId: f.project.id,
			items: [],
			more: false,
			partial: false,
			nextCursor: null,
		});
	}
	assert.equal(await readFile(chat.path, "utf8"), chat.meta);
	assert.equal(await readFile(join(out.target, "latest.json"), "utf8"), out.value);

	for (const [query, projectId, capability, method, status] of [
		["?q=release", f.project.id, "wrong", "GET", 403],
		["?q=release", "missing", f.capability, "GET", 404],
		["?q=release", f.project.id, f.capability, "POST", 405],
		["", f.project.id, f.capability, "GET", 400],
		["?q=%20", f.project.id, f.capability, "GET", 400],
		["?q=release&q=extra", f.project.id, f.capability, "GET", 400],
		["?q=release&projectId=elsewhere", f.project.id, f.capability, "GET", 400],
		[`?q=${encodeURIComponent("🔎".repeat(201))}`, f.project.id, f.capability, "GET", 400],
	] as const) {
		const denied = await request(f, query, projectId, capability, method);
		assert.equal(denied.status, status);
		assert.equal(denied.headers.get("cache-control"), "no-store");
		await denied.arrayBuffer();
	}
});

test("metadata search caps catalog scans and returned title hits", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const { results } = metadataSearchLimits;
	const chat = await seedChat(f, "First chat", f.project.id, 2);
	await seedChat(f, "Second chat", f.project.id, 1);
	const missions = Array.from({ length: results + 1 }, (_, i) =>
		f.store.create({ projectId: f.project.id, title: `Limited mission ${i}` }),
	);
	const last = missions.at(-1)!;
	f.store.join(chat.id, last.id);
	for (let i = 0; i <= results; i++) {
		f.store.linkArtifact(last.id, {
			sessionId: chat.id,
			artifactId: randomUUID(),
			kind: "image",
			title: `Output ${i}`,
			revision: 1,
		});
	}
	await f.sessions.load();
	const output = await searchHttp(f, "output");
	assert.equal(output.items.length, results);
	assert.equal(output.more, true);
	assert.equal(output.partial, false);
	const page = await searchHttp(f, "limited mission");
	assert.equal(page.items.length, results);
	assert.equal(page.more, true);
	assert.equal(page.partial, false);
	assert.equal((await searchHttp(f, "output", output.nextCursor!)).items.length, 1);
	assert.equal((await searchHttp(f, "limited mission", page.nextCursor!)).items.length, 1);
	const first = f.store.metadataSearchMissions(f.project.id, 1);
	assert.deepEqual(first.rows, [{ id: last.id, title: last.title }]);
	assert.ok(first.next);
	assert.equal(f.store.metadataSearchMissions(f.project.id, 1, first.next).rows[0]?.id, missions.at(-2)?.id);
	const links = f.store.metadataSearchOutputLinks(f.project.id, 1);
	assert.equal(links.rows.length, 1);
	assert.equal(links.rows[0]?.title, `Output ${results}`);
	assert.ok(links.next);
	assert.equal(f.store.metadataSearchOutputLinks(f.project.id, 1, links.next).rows[0]?.title, `Output ${results - 1}`);
	const chats = f.sessions.metadataSearchSessions(f.project.id);
	const chat1 = chats(1);
	const chat2 = chats(1);
	assert.equal(chat1.rows.length, 1);
	assert.equal(chat1.more, true);
	assert.equal(chat2.more, false);
	assert.notEqual(chat1.rows[0]?.id, chat2.rows[0]?.id);
});

test("metadata search is complete for an empty output inventory", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	assert.deepEqual(await (await request(f, "?q=readable")).json(), {
		projectId: f.project.id,
		items: [],
		more: false,
		partial: false,
		nextCursor: null,
	});
	const chat = await seedChat(f, "Readable chat", f.project.id, 1);
	await f.sessions.load();
	assert.deepEqual(await (await request(f, "?q=readable")).json(), {
		projectId: f.project.id,
		items: [{ kind: "chat", id: chat.id, title: "Readable chat" }],
		more: false,
		partial: false,
		nextCursor: null,
	});
});

test("metadata search finds a standalone output by its saved title but not its source", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const chat = await seedChat(f, "Archived standalone chat", f.project.id, 2, 3);
	const store = new ArtifactStore(chat.directory, { sessionId: chat.id, projectId: f.project.id });
	const write = { kind: "nsh" as const, source: 'export default () => "source only";', entry: "view.tsx" };
	const first = await store.create({ ...write, title: "Old title" });
	const saved = await store.update(first.id, { ...write, title: "Saved output" }, first.revision);
	await f.sessions.load();
	t.mock.method(ArtifactStore.prototype, "list", () => assert.fail("must not read the unbounded inventory"));
	t.mock.method(ArtifactStore.prototype, "get", () => assert.fail("must not load revisions"));
	t.mock.method(ArtifactStore.prototype, "readCapturedRevision", () => assert.fail("must not load revisions"));

	const res = await request(f, "?q=saved%20output");
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), {
		projectId: f.project.id,
		items: [
			{
				kind: "output",
				artifactKind: "nsh",
				artifactId: saved.id,
				sessionId: chat.id,
				title: "Saved output",
				revision: 2,
				updatedAt: saved.updatedAt,
			},
		],
		more: false,
		partial: false,
		nextCursor: null,
	});
	for (const query of ["source%20only", "old%20title"]) {
		assert.deepEqual(await (await request(f, `?q=${query}`)).json(), {
			projectId: f.project.id,
			items: [],
			more: false,
			partial: false,
			nextCursor: null,
		});
	}
});

test("metadata search skips retired kinds and damaged or unsafe inventory", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const chat = await seedChat(f, "Chat", f.project.id, 2);
	const linkedRoot = await seedChat(f, "Redirected chat", f.project.id, 3);
	const plain = {
		sessionId: chat.id,
		kind: "image",
		title: "Checklist image",
		revision: 2,
		createdAt: 1,
		updatedAt: 2,
	};
	const valid = await seedPointer(chat.directory, plain);
	for (const patch of [
		{ projectId: "foreign" },
		{ sessionId: linkedRoot.id },
		{ revision: 0 },
		{ updatedAt: -1 },
		{ title: { name: "Checklist" } },
		{ kind: "html", title: "Checklist retired format" },
		{ kind: "unknown" },
	]) {
		await seedPointer(chat.directory, { ...plain, ...patch });
	}
	await seedPointer(chat.directory, { ...plain, title: "Checklist oversize", padding: "x".repeat(4096) });
	const malformed = await seedPointer(chat.directory, plain);
	await writeFile(join(malformed.target, "latest.json"), "{");
	const uncommitted = join(chat.directory, "artifacts", randomUUID());
	await mkdir(uncommitted);
	await writeFile(join(uncommitted, "1.json"), JSON.stringify({ ...plain, revision: 1 }));
	const outside = join(f.home, "outside");
	const linkedPointer = await seedPointer(outside, plain);
	const pointerDirectory = join(chat.directory, "artifacts", linkedPointer.id);
	await mkdir(pointerDirectory);
	await symlink(join(linkedPointer.target, "latest.json"), join(pointerDirectory, "latest.json"));
	const linkedDirectory = await seedPointer(outside, plain);
	await symlink(linkedDirectory.target, join(chat.directory, "artifacts", linkedDirectory.id));
	const outsideRoot = join(f.home, "outside-root");
	await seedPointer(outsideRoot, { ...plain, sessionId: linkedRoot.id, title: "Checklist outside" });
	await symlink(join(outsideRoot, "artifacts"), join(linkedRoot.directory, "artifacts"));

	await f.sessions.load();
	const res = await request(f, "?q=checklist");
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), {
		projectId: f.project.id,
		items: [
			{
				kind: "output",
				artifactKind: "image",
				artifactId: valid.id,
				sessionId: chat.id,
				title: "Checklist image",
				revision: 2,
				updatedAt: 2,
			},
		],
		more: false,
		partial: true,
		nextCursor: null,
	});
});

function search(f: Fixture, query: string, cursor?: string, projectId = f.project.id, capability = f.capability) {
	return searchProjectMetadata(f.projects, f.store, f.sessions, projectId, query, capability, cursor);
}

async function searchHttp(f: Fixture, query: string, cursor?: string): ReturnType<typeof search> {
	const params = new URLSearchParams({ q: query });
	if (cursor !== undefined) params.set("cursor", cursor);
	const response = await request(f, `?${params}`);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store");
	return response.json();
}

async function finishSearch(f: Fixture, query: string) {
	const pages = [await searchHttp(f, query)];
	while (pages.at(-1)!.nextCursor !== null) {
		assert.ok(pages.length < 10, "cursor must make progress");
		pages.push(await searchHttp(f, query, pages.at(-1)!.nextCursor!));
	}
	return pages;
}

test("metadata search reaches every owner and entry beyond the original scan limits", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const { outputEntries, outputOwners, results } = metadataSearchLimits;
	const owners = [];
	for (let i = 0; i <= outputOwners; i++) owners.push(await seedChat(f, "Quiet chat", f.project.id, i + 2));
	const expected = new Set<string>();
	for (const owner of owners) {
		const count = owner === owners[0] ? outputEntries + 2 : 1;
		for (let i = 0; i < count; i++) {
			const saved = await seedPointer(owner.directory, {
				sessionId: owner.id,
				kind: "image",
				title: "Hidden needle",
				revision: 5,
				createdAt: 1,
				updatedAt: 2,
			});
			expected.add(saved.id);
		}
	}
	await f.sessions.load();
	const inventory = t.mock.method(ArtifactStore.prototype, "searchMetadata", ArtifactStore.prototype.searchMetadata);
	const pages = await finishSearch(f, "hidden needle");
	assert.equal(inventory.mock.callCount(), owners.length, "do not reopen or reread past owners/entries");
	assert.equal(pages[0]?.partial, true);
	assert.equal(pages.at(-1)?.partial, false);
	for (const page of pages) {
		assert.equal(page.more, page.nextCursor !== null);
		assert.ok(page.items.length <= results);
		for (const item of page.items) {
			assert.equal(item.kind, "output");
			if (item.kind === "output") {
				assert.equal(item.revision, 5);
				assert.ok(expected.delete(item.artifactId), "output must be unique and exact");
			}
		}
	}
	assert.equal(expected.size, 0);
});

test("metadata search resumes all catalogs and keeps canonical pins across scan windows", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const { catalogRows, pinProbes } = metadataSearchLimits;
	metadataSearchLimits.catalogRows = 2;
	metadataSearchLimits.pinProbes = 2;
	t.after(() => {
		metadataSearchLimits.catalogRows = catalogRows;
		metadataSearchLimits.pinProbes = pinProbes;
	});

	const path = join(f.home, "foreign");
	await mkdir(path);
	const foreign = await f.projects.create({ path });
	const chat = await seedChat(f, "Catalog needle chat", f.project.id, 1);
	const pinned = await seedPointer(chat.directory, {
		sessionId: chat.id,
		kind: "image",
		title: "Catalog needle latest",
		revision: 8,
		createdAt: 1,
		updatedAt: 2,
	});
	const early = f.store.create({ projectId: f.project.id, title: "Catalog needle mission" });
	f.store.join(chat.id, early.id);
	const same = { sessionId: chat.id, artifactId: pinned.id, kind: "image" as const };
	f.store.linkArtifact(early.id, { ...same, revision: 5, title: "Catalog needle winner" });
	for (let i = 0; i < 4; i++) {
		const task = f.store.addTask(early.id, { title: `Other task ${i}` });
		f.store.linkArtifact(early.id, { ...same, revision: 2, title: "Catalog needle duplicate", taskId: task.id });
		f.store.create({ projectId: foreign.id, title: "Catalog needle foreign mission" });
		await seedChat(f, "Catalog needle foreign chat", foreign.id, i + 2);
	}
	await f.sessions.load();
	const pages = await finishSearch(f, "catalog needle");
	assert.equal(pages[0]?.more, true);
	assert.deepEqual(pages.flatMap(({ items }) => items.map((item) => item.title)).sort(), [
		"Catalog needle chat",
		"Catalog needle mission",
		"Catalog needle winner",
	]);
	assert.deepEqual(
		(await finishSearch(f, "needle latest")).flatMap((page) => page.items),
		[],
	);
});

test("metadata search scopes cursors and rejects replay; replaced inventory is not read", async (t) => {
	const f = await nativePlanningFixture();
	t.after(() => f.close());
	const path = join(f.home, "foreign");
	await mkdir(path);
	const foreign = await f.projects.create({ path });
	const chat = await seedChat(f, "Owner", f.project.id, 1);
	const inventory = join(chat.directory, "artifacts");
	await mkdir(inventory);
	for (let i = 0; i <= metadataSearchLimits.outputEntries; i++) await writeFile(join(inventory, `ignored-${i}`), "");
	await f.sessions.load();
	const page = await search(f, "needle");
	assert.deepEqual(page.items, []);
	assert.equal(page.more, true);
	assert.equal(page.partial, true);
	assert.ok(page.nextCursor);
	const cursor = page.nextCursor;
	for (const [suffix, projectId, status] of [
		[`?q=different&cursor=${cursor}`, f.project.id, 400],
		[`?q=needle&cursor=${cursor}`, foreign.id, 400],
		[`?q=needle&cursor=${cursor}&cursor=${cursor}`, f.project.id, 400],
		["?q=needle&cursor=../artifacts", f.project.id, 400],
	] as const) {
		const response = await request(f, suffix, projectId);
		assert.equal(response.status, status);
		assert.equal(response.headers.get("cache-control"), "no-store");
		await response.arrayBuffer();
	}
	await assert.rejects(search(f, "different needle", cursor), /invalid or expired/i);
	await assert.rejects(search(f, "needle", cursor, foreign.id), /invalid or expired/i);
	await assert.rejects(search(f, "needle", cursor, f.project.id, "other-capability"), /invalid or expired/i);
	await assert.rejects(search(f, "needle", "../artifacts"), /invalid or expired/i);

	const outside = join(f.home, "outside");
	await mkdir(outside);
	await seedPointer(outside, {
		sessionId: chat.id,
		kind: "image",
		title: "Needle from a replaced directory",
		revision: 1,
		createdAt: 1,
		updatedAt: 1,
	});
	await rename(inventory, join(chat.directory, "old-artifacts"));
	await symlink(join(outside, "artifacts"), inventory);
	assert.deepEqual(await search(f, "needle", cursor), {
		projectId: f.project.id,
		items: [],
		more: false,
		partial: true,
		nextCursor: null,
	});
	await assert.rejects(search(f, "needle", cursor), /invalid or expired/i);
});
