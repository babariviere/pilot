/** Offline only. Export requests, replay externally supplied handoffs, or smoke-test the comparison plumbing. */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { compareHandoffs, parseHandoffResponses } from "./testing/handoff-evaluation.ts";

const { values } = parseArgs({ options: { responses: { type: "string" }, smoke: { type: "boolean" } } });
if (values.smoke && values.responses) throw new Error("--smoke cannot use real responses");
const responses = values.responses
	? parseHandoffResponses(JSON.parse(await readFile(values.responses, "utf8")) as unknown)
	: [];
console.log(JSON.stringify(compareHandoffs(responses, undefined, values.smoke), null, 2));
