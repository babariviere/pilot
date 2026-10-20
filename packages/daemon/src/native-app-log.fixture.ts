/** Native CI runs the real Swift producer, then this production reader against its private fixture files. */
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { DiagnosticLogReader } from "./diagnostic-logs.ts";

// Foundation and Node need not spell temporary-directory aliases identically on macOS.
// Canonicalize only this fixture-owned producer path, never relax the production no-symlink reader.
const root = await realpath(process.argv[2]!);
const host = { hostId: "daemon", daemonId: "fixture-daemon", lineageId: "fixture-lineage" };
const reader = new DiagnosticLogReader({ home: root, appLog: join(root, "app.jsonl"), platform: "darwin" });
const result = await reader.call(host, undefined, true, { action: "search", source: "app", q: "transport_failed" });
assert.equal(result.page?.status, "ok", JSON.stringify(result.page));
assert.equal(result.page?.records.length, 1);
assert.match(result.page!.records[0]!.text, /NSURLErrorDomain/);
assert.match(result.page!.records[0]!.text, /-1001/);
assert.doesNotMatch(JSON.stringify(result), /private-payload|password|userInfo/);
const excerpt = await reader.call(host, undefined, true, { action: "excerpt", ref: result.page!.records[0]!.ref });
assert.equal(excerpt.excerpt?.status, "ok");
console.log("producer-reader-ok");
