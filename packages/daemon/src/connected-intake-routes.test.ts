/** Native intake request contracts against the production router, with offline sources. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SavedLinearRead, TodayIntake } from "@pilot/protocol";
import { nativeIntakeFixture } from "./native-intake.fixture.ts";

const clientRequests = () =>
	["intake", "saved-linear"].map((read) => ({
		path: (projectId: string) => `/api/projects/${projectId}/${read}`,
		header: "x-pilot-github-capability",
	}));
test("intake/Linear requests reach the real router with exact project and native auth", async (t) => {
	const f = await nativeIntakeFixture();
	t.after(() => f.close());
	f.tracking.register("linear", async () => ({ items: [] }));
	await f.tracking.poll(`${f.project.id}:linear`);
	await f.tracking.poll(`${f.other.id}:linear`);
	for (const client of await clientRequests()) {
		const request = (
			project = f.project.id,
			token: string | undefined = f.capability,
			suffix = "",
			origin?: string,
		) =>
			fetch(f.root + client.path(project) + suffix, {
				headers: { ...(token ? { [client.header]: token } : {}), ...(origin ? { origin } : {}) },
				redirect: "manual",
			});
		const read = async (project = f.project.id, suffix = "") => {
			const r = await request(project, f.capability, suffix);
			assert.equal(r.status, 200);
			assert.equal(r.headers.get("cache-control"), "no-store");
			const body = (await r.json()) as TodayIntake | SavedLinearRead;
			assert.equal(body.version, 1);
			assert.equal(body.projectId, project);
			return "sources" in body ? body.sources.flatMap((s) => s.items) : body.items;
		};
		for (const token of ["", "wrong"]) {
			const denied = await request(f.project.id, token);
			assert.equal(denied.status, 403);
			assert.match((await denied.json()).error, /native app/);
		}
		const browser = await request(f.project.id, f.capability, "", "https://example.invalid");
		assert.equal(browser.status, 403);
		assert.deepEqual(await browser.json(), { error: "Browser requests are not allowed" });
		const missing = await request("missing-project");
		assert.equal(missing.status, 404);
		assert.match((await missing.json()).error, /Unknown project/);
		const unknown = await request(f.project.id, f.capability, "/unsupported");
		assert.equal(unknown.status, 404);
		assert.deepEqual(await unknown.json(), { error: "Not found" });
		const method = await fetch(f.root + client.path(f.project.id), { method: "POST" });
		assert.equal(method.status, 405);
		assert.deepEqual(await method.json(), { error: "Intake read is read-only" });
		// A query never chooses a different project. These reads use only the path ID.
		const selected = await read(f.project.id, `?projectId=${f.other.id}`);
		assert.equal(selected.length, 2);
		assert.ok(selected.every((i) => i.projectId === f.project.id));
		const other = await read(f.other.id);
		assert.equal(other.length, 1);
		assert.ok(other.every((i) => i.projectId === f.other.id));
	}
	// Keep storage/read failures distinct from route absence and configuration status.
	f.tracking.intakeSources = async () => {
		throw new Error("Synthetic intake storage failure");
	};
	f.tracking.savedLinear = async () => {
		throw new Error("Synthetic intake storage failure");
	};
	for (const client of await clientRequests()) {
		const r = await fetch(f.root + client.path(f.project.id), { headers: { [client.header]: f.capability } });
		assert.equal(r.status, 400);
		assert.deepEqual(await r.json(), { error: "Synthetic intake storage failure" });
	}
	assert.deepEqual(f.stats(), { external: 0, sessions: 0 });
});

test("intake reads distinguish not configured, saved rows, missing services and unsupported routes", async (t) => {
	const clients = await clientRequests();
	const f = await nativeIntakeFixture();
	t.after(() => f.close());
	// Establish source provenance with an offline provider only. GET itself must never poll.
	let polls = 0;
	f.tracking.register("linear", async () => {
		polls++;
		return {
			items: [
				{
					externalId: "saved",
					title: "Saved issue",
					url: "https://example.invalid/issue",
					status: "Todo",
					metadata: {},
					updatedAt: 1,
				},
			],
		};
	});
	await f.tracking.poll(`${f.project.id}:linear`);
	for (const client of clients) {
		const get = async () => {
			const r = await fetch(f.root + client.path(f.project.id), { headers: { [client.header]: f.capability } });
			assert.equal(r.status, 200);
			return (await r.json()) as TodayIntake | SavedLinearRead;
		};
		const page = await get();
		const items = "sources" in page ? page.sources[1]!.items : page.items;
		assert.equal(items.length, 3, "saved rows remain alongside the newly synced row");
		assert.ok(items.some((i) => i.externalId === "saved"));
		assert.ok(items.every((i) => i.projectId === f.project.id));
		if ("configurationCurrent" in page) assert.equal(page.configurationCurrent, true);
	}
	await f.projects.update(f.project.id, { tracking: { slackChannels: [] } });
	for (const client of clients) {
		const r = await fetch(f.root + client.path(f.project.id), { headers: { [client.header]: f.capability } });
		assert.equal(r.status, 200, "unconfigured is a supported response, not missing API support");
		const page = (await r.json()) as TodayIntake | SavedLinearRead;
		if ("sources" in page) {
			assert.deepEqual(
				page.sources.map((s) => [s.source, s.status, s.items.length]),
				[
					["slack", "not_configured", 0],
					["linear", "idle", 0],
				],
			);
		} else {
			assert.equal(page.configurationCurrent, false);
			assert.equal(page.source.status, "not_configured");
			assert.deepEqual(page.items, []);
		}
	}
	assert.equal(polls, 1);
	assert.deepEqual(f.stats(), { external: 0, sessions: 0 });
	for (const options of [{ tracking: false }, { nativeAuth: false }]) {
		const unavailable = await nativeIntakeFixture(options);
		try {
			for (const client of clients) {
				const r = await fetch(unavailable.root + client.path(unavailable.project.id), {
					headers: { [client.header]: unavailable.capability },
				});
				assert.equal(r.status, 503);
				assert.deepEqual(await r.json(), { error: "Native intake unavailable" });
			}
			assert.deepEqual(unavailable.stats(), { external: 0, sessions: 0 });
		} finally {
			await unavailable.close();
		}
	}
});
