import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChatSettings } from "@pilot/protocol";
import { ChatSettingsService } from "./chat-settings.ts";
import { ModelCatalog } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { createDaemonServer } from "./server.ts";
import { SessionManager } from "./sessions.ts";
import { TerminalManager } from "./terminals.ts";

test("chat settings HTTP validates exact PATCH, reports conflicts and unavailable persistence", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pilot-chat-settings-api-"));
	const settings = await ChatSettingsService.open(home);
	const projects = new ProjectStore(home);
	const sessions = new SessionManager(home, projects);
	const terminals = new TerminalManager();
	const server = createDaemonServer(
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
		false,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		settings,
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chat-settings`;
	t.after(async () => {
		await sessions.shutdown();
		await terminals.shutdown();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(home, { recursive: true, force: true });
	});
	const initial = (await (await fetch(url)).json()) as ChatSettings;
	assert.equal(initial.autoHandoff, false);
	const patch = (body: unknown) =>
		fetch(url, { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
	for (const input of [
		null,
		[],
		{},
		{ autoHandoff: true },
		{ autoHandoff: 1, expectedRevision: initial.revision },
		{ autoHandoff: true, expectedRevision: initial.revision, extra: true },
	]) {
		assert.equal((await patch(input)).status, 400);
	}
	const saved = await patch({ autoHandoff: true, expectedRevision: initial.revision });
	assert.equal(saved.status, 200);
	assert.equal(((await saved.json()) as ChatSettings).autoHandoff, true);
	const stale = await patch({ autoHandoff: false, expectedRevision: initial.revision });
	assert.equal(stale.status, 409);
	assert.match(await stale.text(), /revision conflict/);
	// Force a pre-rename failure. The API must not return the proposed value as saved.
	await rm(home, { recursive: true, force: true });
	await writeFile(home, "not a directory");
	const current = (await (await fetch(url)).json()) as ChatSettings;
	assert.equal((await patch({ autoHandoff: false, expectedRevision: current.revision })).status, 503);
	assert.equal((await fetch(url)).status, 503);
});
