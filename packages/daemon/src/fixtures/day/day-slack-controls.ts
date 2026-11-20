/** Isolated real daemon/native storage, synthetic Slack reads only. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { serveCommands } from "../commands.ts";
import { nativeIntakeFixture } from "../../day/intake/native-intake.fixture.ts";

const f = await nativeIntakeFixture();
const ledger = join(f.home, "commands.jsonl");
let imports = 0,
	lost = false;
let drop = false;
const handlers = f.server.listeners("request") as ((req: IncomingMessage, res: ServerResponse) => void)[];
f.server.removeAllListeners("request");
f.server.on("request", (req, res) => {
	if (drop && req.method === "POST" && req.url === "/api/operations") {
		drop = false;
		req.resume();
		res.destroy();
		return;
	}
	for (const handle of handlers) handle(req, res);
});
f.setSlackAdder(async (_context, link) => {
	assert((await readFile(ledger, "utf8")).includes('"kind":"slack-controls"'), "native journal precedes effect");
	imports++;
	return {
		externalId: `${link.channel}/${link.threadTs}`,
		title: "Imported client report",
		url: `https://example.slack.com/archives/${link.channel}/p${link.threadTs.replace(".", "")}`,
		status: "open",
		metadata: { manual: true, channel: link.channel, threadTs: link.threadTs },
		updatedAt: Date.now(),
		slack: { type: "bug", label: null, severity: "medium", status: "open", overrides: {} },
	};
});
const add = f.tracking.slack.add.bind(f.tracking.slack);
f.tracking.slack.add = async (...args) => {
	const item = await add(...args);
	if (lost) {
		lost = false;
		throw new Error("Lost domain acknowledgement");
	}
	return item;
};
console.log(
	JSON.stringify({
		source: {
			profile: f.home,
			port: Number(new URL(f.root).port),
			home: { daemonId: f.hello.daemonId, lineageId: f.hello.lineageId },
			project_id: f.project.id,
			project_path: f.project.path,
		},
		ledger,
	}),
);
await serveCommands(async (c) => {
	if (c.action === "lost") lost = true;
	if (c.action === "drop") drop = true;
	if (c.action === "change") await f.projects.update(f.project.id, { name: "Changed project" });
	if (c.action === "defer-old") {
		const item = (await f.items.list({ projectId: f.project.id, kind: "slack", offset: 100, limit: 1 })).items[0]!;
		await f.items.intakeWrite(f.project.id, item.id, item.revision, "later");
	}
	if (c.action === "many")
		await f.items.commit(
			f.project.id,
			"slack",
			Array.from({ length: 201 }, (_, n) => ({
				externalId: `COTHER/${1794843000 + n}.000001`,
				title: `Saved report ${n}`,
				url: `https://example.slack.com/archives/COTHER/p${1794843000 + n}000001`,
				status: "open",
				metadata: { manual: true, channel: "COTHER", thread_ts: `${1794843000 + n}.000001`, type: "bug" },
				updatedAt: Date.now() - n,
			})),
		);
	return {
		imports,
		external: f.stats().external,
		tracking: f.projects.require(f.project.id).tracking,
		intake: await f.tracking.intakeSources(f.project.id),
	};
});
await f.close();
