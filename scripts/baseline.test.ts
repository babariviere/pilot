import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { loadBaseline, loadBaselineSource } from "./bench/baseline.ts";

test("baseline keeps imports, resource URLs and workspace resolution beside the source", async (t) => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "baseline space #")));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const source = pathToFileURL(join(directory, "src", "original.ts"));
	await mkdir(new URL("./", source), { recursive: true });
	await mkdir(join(directory, "node_modules", "fixture"), { recursive: true });
	await writeFile(
		join(directory, "node_modules", "fixture", "package.json"),
		JSON.stringify({ type: "module", exports: "./index.js" }),
	);
	await writeFile(join(directory, "node_modules", "fixture", "index.js"), "export const packageValue = 7;");
	await writeFile(new URL("./sibling.mjs", source), "export const sibling = 3;");
	await writeFile(
		new URL("./worker.mjs", source),
		"import { parentPort } from 'node:worker_threads'; parentPort.postMessage(11);",
	);
	const history = `
		import { Worker } from 'node:worker_threads';
		import { once } from 'node:events';
		import { packageValue } from 'fixture';
		export { sibling } from './sibling.mjs';
		export const resource = new URL('./resource.json', import.meta.url).href;
		export const value: number = packageValue;
		export const dynamic = (await import('./sibling.mjs')).sibling;
		export const directory = import.meta.dirname;
		export async function workerValue() {
			const worker = new Worker(new URL('./worker.mjs', import.meta.url));
			return (await once(worker, 'message'))[0];
		}
	`;
	const loaded = await loadBaselineSource<{
		value: number;
		sibling: number;
		dynamic: number;
		directory: string;
		resource: string;
		workerValue(): Promise<number>;
	}>(history, source);
	try {
		await writeFile(source, history);
		const current = await import(source.href);
		assert.equal(loaded.module.value, 7);
		assert.equal(loaded.module.sibling, 3);
		assert.equal(loaded.module.dynamic, 3);
		assert.equal(loaded.module.directory, join(directory, "src"));
		assert.equal(loaded.module.resource, new URL("./resource.json", source).href);
		assert.equal(loaded.module.resource, current.resource);
		assert.equal(loaded.module.directory, current.directory);
		assert.equal(await loaded.module.workerValue(), 11);
	} finally {
		await loaded.cleanup();
	}
	assert.deepEqual(await readdir(new URL("./", source)), ["original.ts", "sibling.mjs", "worker.mjs"]);
});

test("failed baseline import cleans up its temporary module", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "baseline-failure-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await assert.rejects(
		loadBaselineSource("throw Error('fixture failure');", pathToFileURL(join(directory, "source.ts"))),
		/fixture failure/,
	);
	assert.deepEqual(await readdir(directory), []);
});

test("git and jj baselines use a disposable repository, not the checkout", async (t) => {
	const { execFileSync } = await import("node:child_process");
	const directory = await realpath(await mkdtemp(join(tmpdir(), "baseline-repository-")));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const jj = (...args: string[]) =>
		execFileSync("jj", ["--config", "user.name=Fixture", "--config", "user.email=fixture@example.invalid", ...args], {
			cwd: directory,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	jj("git", "init", "--colocate");
	await mkdir(join(directory, "src"));
	const original = pathToFileURL(join(directory, "src", "entry.ts"));
	await writeFile(original, 'export { sibling } from "./sibling.mjs"; export const historical: number = 1;');
	await writeFile(new URL("./sibling.mjs", original), "export const sibling = 1;");
	jj("describe", "-m", "baseline fixture");
	const revision = jj("log", "-r", "@", "--no-graph", "-T", "commit_id");
	jj("new");
	await writeFile(original, "throw Error('current entry must not execute');");
	await writeFile(new URL("./sibling.mjs", original), "export const sibling = 2;");
	for (const vcs of ["git", "jj"] as const) {
		const loaded = await loadBaseline<{ historical: number; sibling: number }>(revision, original, vcs);
		try {
			assert.equal(loaded.module.historical, 1);
			assert.equal(loaded.module.sibling, 2);
		} finally {
			await loaded.cleanup();
		}
	}
	await assert.rejects(loadBaseline("main", original), /baseline commit hash/);
	await assert.rejects(loadBaseline("0".repeat(40), original));
	assert.deepEqual(await readdir(new URL("./", original)), ["entry.ts", "sibling.mjs"]);
});
