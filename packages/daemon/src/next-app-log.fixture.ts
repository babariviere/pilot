/** Explicit synthetic Rust-producer bridge. Never run against a live capture root. */
import assert from "node:assert/strict";
import { DiagnosticLogReader } from "./diagnostic-logs.ts";

const [root, daemonId, lineageId] = process.argv.slice(2);
assert.ok(root && daemonId && lineageId);
const host = { hostId: "daemon", daemonId, lineageId };
const reader = new DiagnosticLogReader({
	home: root,
	nextAppRoot: root,
	platform: "darwin",
	nextAppControl: () => ({ localDiagnostics: true, epoch: 0 }),
});
const inventory = await reader.call(host, undefined, true, { action: "inventory" }, undefined, true);
assert.equal(inventory.sources?.find((s) => s.id === "next_app")?.availableFiles, 3);
const page = (
	await reader.call(host, undefined, true, { action: "search", source: "next_app", limit: 40 }, undefined, true)
).page!;
assert.equal(page.records.length, 2);
assert.equal(page.omissions?.legacy, 1);
assert.equal(page.omissions?.unbound, 1);
assert.match(page.records[0]!.text, /"response_received":true/);
assert.doesNotMatch(page.records[0]!.text, /accepted|durable|delivered/);
assert.match(page.records[1]!.text, /"outcome":"refused"/);
assert.match(page.records[1]!.text, /"dropped":7/);
const search = await reader.call(
	host,
	undefined,
	true,
	{ action: "search", source: "next_app", q: "refused" },
	undefined,
	true,
);
assert.equal(search.page?.records.length, 1);
const excerpt = await reader.call(
	host,
	undefined,
	true,
	{ action: "excerpt", ref: search.page!.records[0]!.ref },
	undefined,
	true,
);
assert.equal(excerpt.excerpt?.status, "ok");
assert.equal(
	(await reader.call(host, undefined, true, { action: "search", source: "app" }, undefined, true)).page?.records
		.length,
	0,
);
console.log("next-producer-reader-ok");
