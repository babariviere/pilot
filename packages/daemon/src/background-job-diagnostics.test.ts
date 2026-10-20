import assert from "node:assert/strict";
import { test } from "node:test";
import { BackgroundJobDiagnostics } from "./background-job-diagnostics.ts";

test("job evidence separates idle, real queues, local stages, RPC calls, no-work, errors and config fences", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1000 });
	const jobs = new BackgroundJobDiagnostics();
	jobs.register("slack_done_write", "slack");
	const read = () => jobs.read("slack_done_write", "slack", "p", "config");
	assert.equal(read().state, "idle_unobserved");
	jobs.queue("slack_done_write", "slack", "p", "config");
	assert.equal(read().state, "queued");
	const token = jobs.begin("slack_done_write", "slack", "p", "config");
	jobs.stage(token, "reserve");
	assert.equal(read().observation?.readCalls, 0);
	assert.equal(read().state, "running");
	jobs.stage(token, "write", true);
	jobs.progress(token);
	jobs.end(token, "success", undefined, 1);
	assert.equal(read().state, "success");
	assert.equal(read().observation?.writeCalls, 1);
	const empty = jobs.begin("slack_done_write", "slack", "p", "config");
	jobs.end(empty, "no_work", undefined, 0);
	assert.equal(read().state, "no_work");
	assert.equal(read().observation?.recent?.find((r) => r.outcome === "success")?.writeCalls, 1);
	jobs.end(token, "failure", "unknown");
	assert.equal(read().state, "no_work", "late completion cannot overwrite a newer attempt");
	const other = jobs.begin("triage_rebuild", "slack", "p", "config");
	jobs.end(other, "failure", "classification_failed", undefined, 2000);
	assert.equal(jobs.read("triage_rebuild", "slack", "p", "config").installed, false);
	assert.equal(jobs.read("slack_done_write", "slack", "p", "replacement").observation, undefined);
	jobs.prune(() => "replacement");
	jobs.end(empty, "success");
	assert.equal(read().observation, undefined);
	jobs.setEnabled(false);
	jobs.begin("slack_done_write", "slack", "p", "config");
	assert.equal(read().state, "disabled");
	jobs.setEnabled(true);
	assert.equal(read().state, "idle_unobserved");
});

test("job key and recent-outcome cardinality stay bounded; clear invalidates active tokens", () => {
	const jobs = new BackgroundJobDiagnostics();
	for (let i = 0; i < 300; i++) jobs.begin("triage_rebuild", "slack", `p${i}`, "config");
	assert.equal(jobs.coverage().dropped, 44);
	assert.equal(jobs.read("triage_rebuild", "slack", "p0", "config").observation, undefined);
	let token = jobs.begin("manual_lookup", "linear", undefined, "host");
	for (let i = 0; i < 12; i++) {
		token = jobs.begin("manual_lookup", "linear", undefined, "host");
		jobs.end(token, "no_work");
	}
	assert.equal(jobs.read("manual_lookup", "linear", undefined, "host").observation?.recent?.length, 4);
	jobs.clear();
	jobs.end(token, "failure");
	assert.equal(jobs.read("manual_lookup", "linear", undefined, "host").observation, undefined);
});
