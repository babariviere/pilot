import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { test } from "node:test";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import { ReviewToolAdmission } from "./critical-review-admission.ts";
import {
	type CodeActivity,
	type RecordedVerification,
	type SessionCodeCapture,
	SessionCodeCapturer,
} from "./critical-review-code.ts";
import {
	CODE_CAPTURE_LIMITS,
	type CodeTreeScan,
	type CodeWorkspace,
	scanCodeTree,
} from "./critical-review-code-tree.ts";
import { CriticalReviewStore } from "./critical-review-store.ts";
import { CriticalReviewVault } from "./critical-review-vault.ts";

const execute = promisify(execFile);
const deferred = <T = void>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};
const empty = (): CodeActivity => ({ revision: "revision", children: [], jobs: [], complete: true });
const job = (extra: Partial<RecordedVerification> = {}): RecordedVerification => ({
	id: "test",
	receiptId: "receipt",
	label: "Synthetic focused test command",
	output: "unavailable",
	kind: "test",
	state: "done",
	exitCode: 0,
	conclusion: "passed",
	testedSha: null,
	testedTree: null,
	testedTreeKind: null,
	...extra,
});
async function fixture() {
	const home = await realpath(await mkdtemp(join(tmpdir(), "code-capture-")));
	const root = join(home, "workspace");
	await mkdir(root);
	const git = async (...args: string[]) =>
		(
			await execute("/usr/bin/git", ["-C", root, ...args], {
				env: {
					PATH: "/usr/bin:/bin",
					HOME: home,
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_AUTHOR_NAME: "Synthetic",
					GIT_AUTHOR_EMAIL: "fake@example.test",
					GIT_COMMITTER_NAME: "Synthetic",
					GIT_COMMITTER_EMAIL: "fake@example.test",
				},
			})
		).stdout.trim();
	await git("init", "--initial-branch=main");
	await writeFile(join(root, "file.ts"), "starting baseline\n");
	await writeFile(join(root, "deleted.ts"), "will be deleted\n");
	await writeFile(join(root, ".gitignore"), "ignored*\n");
	await git("add", ".");
	await git("commit", "-m", "Synthetic baseline");
	const workspace: CodeWorkspace = {
		root,
		gitDirectory: join(root, ".git"),
		baseline: await git("rev-parse", "HEAD"),
	};
	const store = new CriticalReviewStore(join(home, "records.sqlite"), () => 100);
	const vault = new CriticalReviewVault(join(home, "vault"), store);
	await vault.recover();
	const admission = new ReviewToolAdmission();
	const request = (id = "capture"): SessionCodeCapture => ({
		id,
		projectId: "project",
		hostId: "host",
		createdAt: 100,
		knownSecrets: [],
		sourceId: "source",
		sessionId: "author",
		attemptId: 1,
		boundary: 4,
		workspace,
	});
	async function contents(id = "capture") {
		const manifest = await vault.manifest(id);
		const entries = new Map<string, string>();
		for (const entry of manifest.entries) {
			let next: number | undefined = 0,
				text = "";
			do {
				const page = await vault.read(id, entry.blobId, next);
				text += page.text;
				next = page.next;
			} while (next !== undefined);
			entries.set(entry.label, text);
		}
		return { manifest, entries, report: JSON.parse(entries.get("code/capture.json")!) };
	}
	return {
		home,
		root,
		git,
		workspace,
		store,
		vault,
		admission,
		request,
		contents,
		capturer: (read: () => Promise<CodeActivity> = async () => empty()) =>
			new SessionCodeCapturer(admission, { read }),
		close: async () => {
			await store.close();
			await rm(home, { recursive: true, force: true });
		},
	};
}

test("safe-boundary hold drains foreground tools, blocks new starts, and never cancels existing work", async () => {
	const gate = new ReviewToolAdmission(),
		controller = new AbortController();
	const done = await gate.enter(controller.signal);
	const held = gate.hold(controller.signal);
	let started = false;
	const next = gate.enter(controller.signal).then((release) => {
		started = true;
		return release;
	});
	await Promise.resolve();
	assert.equal(started, false);
	done();
	done();
	const release = await held;
	assert.equal(started, false);
	assert.equal(controller.signal.aborted, false);
	release();
	release();
	(await next)();
	assert.equal(started, true);
});

test("cancelling a boundary wait releases new admission without stopping the active tool", async () => {
	const gate = new ReviewToolAdmission(),
		controller = new AbortController();
	const done = await gate.enter(new AbortController().signal);
	const held = gate.hold(controller.signal);
	controller.abort(new Error("cancelled"));
	await assert.rejects(held, /cancelled/);
	(await gate.enter(new AbortController().signal))();
	done();
});

test("dirty source capture seals starting baseline, staged/unstaged and nonignored untracked bytes without index mutation", async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.root, "file.ts"), "staged\n");
		await f.git("add", "file.ts");
		await writeFile(join(f.root, "file.ts"), "unstaged final\n");
		await writeFile(join(f.root, "new.ts"), "eligible untracked\n");
		await writeFile(join(f.root, "ignored-secret"), "not eligible\n");
		await rm(join(f.root, "deleted.ts"));
		const index = await readFile(join(f.root, ".git", "index"));
		const start = performance.now();
		await f.capturer().capture(f.vault, f.request());
		const elapsed = performance.now() - start;
		const { entries, manifest, report } = await f.contents();
		assert.equal(entries.get("code/baseline/source/file.ts"), "starting baseline\n");
		assert.equal(entries.get("code/tree/source/file.ts"), "unstaged final\n");
		assert.equal(entries.get("code/tree/source/new.ts"), "eligible untracked\n");
		assert.equal(JSON.parse(entries.get("code/tree/inventory/deleted.ts")!).state, "deleted");
		assert.equal(
			[...entries.keys()].some((p) => p.includes("ignored-secret")),
			false,
		);
		assert.deepEqual(await readFile(join(f.root, ".git", "index")), index);
		assert.equal(report.baseline, f.workspace.baseline);
		assert.equal(report.inventoryComparison, "matched");
		assert.equal(report.attempts, 1);
		assert.equal(report.coverage.atomic, false);
		assert.equal(manifest.complete, false);
		assert.doesNotMatch(JSON.stringify([...entries]), new RegExp(f.home));
		await rm(f.root, { recursive: true });
		assert.equal((await f.contents()).entries.get("code/tree/source/file.ts"), "unstaged final\n");
		console.log(`synthetic dirty capture: ${elapsed.toFixed(1)}ms, ${manifest.entries.length} entries`);
	} finally {
		await f.close();
	}
});

test("missing and explicitly unavailable workspaces offer conversation-only evidence without recreating paths", async () => {
	const f = await fixture();
	try {
		await rm(f.root, { recursive: true });
		for (const missing of [true, false]) {
			const input = f.request(missing ? "missing" : "null");
			if (!missing) input.workspace = null;
			await f.capturer().capture(f.vault, input);
			const { report } = await f.contents(input.id);
			assert.equal(report.workspace, "missing");
			assert.equal(report.conversationOnlyAvailable, true);
			assert.equal(report.treeDigest, null);
		}
		assert.equal((await readdir(f.home)).includes("workspace"), false);
	} finally {
		await f.close();
	}
});

test("job completion retains both observations; null/unknown exits and cancellation cannot become passes", async () => {
	const f = await fixture();
	try {
		let read = 0;
		const captured = await scanCodeTree(f.workspace);
		await f
			.capturer(async () => ({
				...empty(),
				revision: `r${++read}`,
				children: [{ id: "child", state: "running" }],
				jobs:
					read === 1
						? [job({ state: "running", exitCode: null, conclusion: "unknown" })]
						: [
								job({
									testedSha: f.workspace.baseline,
									testedTree: captured.treeDigest,
									testedTreeKind: "code_inventory_v1",
								}),
								job({ id: "null-exit", exitCode: null, output: "truncated" }),
								job({ id: "unknown", conclusion: "unknown" }),
								job({ id: "cancelled", state: "cancelled" }),
								job({ id: "interrupted", state: "interrupted" }),
								job({ id: "other-tree", testedTree: "a".repeat(64), testedTreeKind: "code_inventory_v1" }),
								job({
									id: "git-tree",
									testedSha: f.workspace.baseline,
									testedTree: "a".repeat(40),
									testedTreeKind: "git_tree",
								}),
								job({ id: "nonzero", exitCode: 1 }),
								job({ id: "failed", state: "failed" }),
							],
			}))
			.capture(f.vault, f.request());
		const { report } = await f.contents();
		assert.equal(report.activityBefore.jobs[0].outcome, "running");
		assert.deepEqual(
			report.activityAfter.jobs.map((j: { outcome: string }) => j.outcome),
			["passed", "unknown", "unknown", "cancelled", "interrupted", "passed", "passed", "failed", "failed"],
		);
		assert.equal(report.activityAfter.jobs[0].treeAssociation, "same_tree");
		assert.equal(report.activityAfter.jobs[1].treeAssociation, "unknown");
		assert.equal(report.activityAfter.jobs[1].output, "truncated");
		assert.equal(report.activityAfter.jobs[0].label, "Synthetic focused test command");
		assert.equal(report.activityAfter.jobs[5].treeAssociation, "different_tree");
		assert.equal(report.activityAfter.jobs[6].treeAssociation, "unknown");
		assert.equal(report.activityAfter.jobs[6].testedSha, f.workspace.baseline);
		assert.equal(report.activityAfter.children[0].state, "running");
	} finally {
		await f.close();
	}
});

// Instrument only the inventory boundary, not production entry points, for deterministic external-writer races.
type ScanSeam = { scan(workspace: CodeWorkspace, signal: AbortSignal): Promise<CodeTreeScan> };
for (const persistent of [false, true])
	test(`external writer race is partial, with at most one retry (persistent=${persistent})`, async (t) => {
		const f = await fixture();
		try {
			let reads = 0;
			const capturer = f.capturer();
			t.mock.method(capturer as unknown as ScanSeam, "scan", async (workspace: CodeWorkspace) => {
				const result = await scanCodeTree(workspace);
				if (++reads === 1 || persistent) await writeFile(join(f.root, "file.ts"), `external revision ${reads}\n`);
				return result;
			});
			await capturer.capture(f.vault, f.request());
			const { report, manifest } = await f.contents();
			assert.equal(reads, 4);
			assert.equal(report.attempts, 2);
			assert.equal(report.raceObserved, true);
			assert.equal(report.inventoryComparison, "partial");
			assert.equal(manifest.complete, false);
			assert.notEqual(report.comparisons[0].pre.treeDigest, report.comparisons[0].post.treeDigest);
		} finally {
			await f.close();
		}
	});

test("cancellation while a tool is active does not abort it, seal evidence or strand admission", async () => {
	const f = await fixture();
	try {
		const done = await f.admission.enter(new AbortController().signal);
		const observed = deferred();
		const capturer = f.capturer(async () => {
			observed.resolve();
			return empty();
		});
		const controller = new AbortController();
		const capture = capturer.capture(f.vault, f.request(), controller.signal);
		await observed.promise;
		controller.abort();
		await assert.rejects(capture, /cancelled/);
		assert.equal(await f.store.get("evidence", "capture"), undefined);
		(await f.admission.enter(new AbortController().signal))();
		done();
		await capturer.capture(f.vault, { ...f.request("later"), workspace: null });
	} finally {
		await f.close();
	}
});

test("cancelled non-cooperative activity reads retain bounded admission and never publish late evidence", async () => {
	const f = await fixture();
	try {
		const waiting = deferred<CodeActivity>(),
			entered = deferred();
		const capturer = f.capturer(async () => {
			entered.resolve();
			return waiting.promise;
		});
		const controller = new AbortController();
		const capture = capturer.capture(f.vault, f.request(), controller.signal);
		await entered.promise;
		controller.abort();
		await assert.rejects(capture, /cancelled/);
		await assert.rejects(capturer.capture(f.vault, f.request("another")), /busy/);
		waiting.resolve(empty());
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(await f.store.get("evidence", "capture"), undefined);
	} finally {
		await f.close();
	}
});

test("secret paths/text, binary files, symlinks and hardlinks are omitted without leaking global filenames", async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.root, ".env"), "PRIVATE_PAYLOAD");
		await writeFile(join(f.root, "credential.ts"), "HOST_KNOWN_SECRET");
		await writeFile(join(f.root, "binary"), Buffer.from([0, 255]));
		await symlink(f.home, join(f.root, "outside"));
		await link(join(f.root, "file.ts"), join(f.root, "hardlink"));
		const input = f.request();
		input.knownSecrets = ["HOST_KNOWN_SECRET"];
		await f.capturer().capture(f.vault, input);
		const { entries, manifest } = await f.contents();
		const all = JSON.stringify([...entries]);
		assert.doesNotMatch(all, /PRIVATE_PAYLOAD|HOST_KNOWN_SECRET|\.env/);
		assert.equal(entries.has("code/tree/source/outside"), false);
		assert.equal(entries.has("code/tree/source/hardlink"), false);
		assert.equal(
			manifest.omissions.some((o) => o.reason === "secret"),
			true,
		);
		assert.equal(
			manifest.omissions.some((o) => o.reason === "binary"),
			true,
		);
	} finally {
		await f.close();
	}
});

test("hostile repository hooks and filters are never executed, and executables remain data", async () => {
	const f = await fixture();
	try {
		const marker = join(f.home, "EXECUTED");
		await f.git("config", "core.fsmonitor", `touch ${marker}`);
		await f.git("config", "filter.hostile.clean", `touch ${marker}`);
		await writeFile(join(f.root, ".gitattributes"), "* filter=hostile diff=hostile\n");
		await writeFile(join(f.root, "run.sh"), `#!/bin/sh\ntouch ${marker}\n`);
		await chmod(join(f.root, "run.sh"), 0o755);
		await f.capturer().capture(f.vault, f.request());
		assert.equal((await readdir(f.home)).includes("EXECUTED"), false);
		assert.equal(JSON.parse((await f.contents()).entries.get("code/tree/inventory/run.sh")!).mode, "100755");
	} finally {
		await f.close();
	}
});

test("unsupported baseline, invalid receipts and over-limit blobs fail without mutating author data", async () => {
	const f = await fixture();
	try {
		await assert.rejects(
			f.capturer().capture(f.vault, { ...f.request(), workspace: { ...f.workspace, baseline: "HEAD" } }),
			/scope/,
		);
		await assert.rejects(
			f
				.capturer(async () => ({ ...empty(), jobs: [job({ exitCode: undefined as unknown as null })] }))
				.capture(f.vault, f.request()),
			/receipt/,
		);
		await writeFile(join(f.root, "oversized"), Buffer.alloc(CODE_CAPTURE_LIMITS.blobBytes + 1, 65));
		await assert.rejects(f.capturer().capture(f.vault, f.request()), /unavailable or over limit/);
		assert.equal(await f.store.get("evidence", "capture"), undefined);
		assert.equal((await readdir(join(f.root, ".git"))).includes("index.lock"), false);
	} finally {
		await f.close();
	}
});

test("bounded hold expiry releases admission but leaves an existing tool running", async (t) => {
	const f = await fixture();
	try {
		const done = await f.admission.enter(new AbortController().signal);
		const entered = deferred();
		const hold = f.admission.hold.bind(f.admission);
		t.mock.method(f.admission, "hold", (signal: AbortSignal) => {
			const waiting = hold(signal);
			entered.resolve();
			return waiting;
		});
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const capture = f.capturer().capture(f.vault, f.request());
		await entered.promise;
		t.mock.timers.tick(CODE_CAPTURE_LIMITS.holdMs + 1);
		await assert.rejects(capture, /cancelled/);
		(await f.admission.enter(new AbortController().signal))();
		done();
		t.mock.timers.reset();
		assert.equal(await f.store.get("evidence", "capture"), undefined);
	} finally {
		t.mock.timers.reset();
		await f.close();
	}
});

test("cancelling actual worker acquisition cleans up without publishing or stranding the next capture", async (t) => {
	const f = await fixture();
	try {
		const capturer = f.capturer(),
			controller = new AbortController();
		const seam = capturer as unknown as ScanSeam;
		const scan = seam.scan.bind(capturer);
		const mocked = t.mock.method(seam, "scan", (workspace: CodeWorkspace, signal: AbortSignal) => {
			const pending = scan(workspace, signal);
			controller.abort();
			return pending;
		});
		await assert.rejects(capturer.capture(f.vault, f.request(), controller.signal), /cancelled/);
		assert.equal(await f.store.get("evidence", "capture"), undefined);
		mocked.mock.restore();
		await capturer.capture(f.vault, { ...f.request("next"), workspace: null });
	} finally {
		await f.close();
	}
});

test("index-only mutations are detected even if working bytes do not change", async (t) => {
	const f = await fixture();
	try {
		let scans = 0;
		const capturer = f.capturer();
		t.mock.method(capturer as unknown as ScanSeam, "scan", async (workspace: CodeWorkspace) => {
			const result = await scanCodeTree(workspace);
			if (++scans === 1) await f.git("update-index", "--assume-unchanged", "file.ts");
			if (scans === 1) await f.git("update-index", "--force-remove", "file.ts");
			return result;
		});
		await capturer.capture(f.vault, f.request());
		const { report } = await f.contents();
		assert.equal(report.raceObserved, true);
		assert.equal(scans, 4);
		assert.notEqual(report.comparisons[0].pre.indexDigest, report.comparisons[0].post.indexDigest);
	} finally {
		await f.close();
	}
});

test("missing source after an available inventory is partial and never restored", async (t) => {
	const f = await fixture();
	try {
		let scans = 0;
		const capturer = f.capturer();
		t.mock.method(capturer as unknown as ScanSeam, "scan", async (workspace: CodeWorkspace) => {
			const result = await scanCodeTree(workspace);
			if (++scans === 1) await rm(f.root, { recursive: true });
			return result;
		});
		await capturer.capture(f.vault, f.request());
		const { report } = await f.contents();
		assert.equal(report.raceObserved, true);
		assert.equal(report.conversationOnlyAvailable, true);
		assert.equal(report.inventoryComparison, "partial");
		assert.equal((await readdir(f.home)).includes("workspace"), false);
	} finally {
		await f.close();
	}
});

test("capture pins host request fields and strips private activity extras", async () => {
	const f = await fixture();
	try {
		const input = f.request();
		const capturer = f.capturer(async () => {
			input.sessionId = "retargeted";
			input.workspace = null;
			return { ...empty(), outputPath: "/private/path", logs: "PRIVATE_LOG_PAYLOAD" };
		});
		await capturer.capture(f.vault, input);
		const { report } = await f.contents();
		assert.equal(report.sessionId, "author");
		assert.equal(report.workspace, "available");
		assert.doesNotMatch(JSON.stringify(report), /PRIVATE_LOG_PAYLOAD|\/private\/path/);
		await f.vault.eraseSource("source");
		await assert.rejects(f.vault.manifest("capture"), /unavailable/);
	} finally {
		await f.close();
	}
});

test("ignored paths removed from the index are not accidentally reimported from the starting baseline", async () => {
	const f = await fixture();
	try {
		await f.git("rm", "--cached", "file.ts");
		await writeFile(join(f.root, ".gitignore"), "file.ts\n");
		await writeFile(join(f.root, "file.ts"), "NEW_IGNORED_PRIVATE_TEXT");
		await f.capturer().capture(f.vault, f.request());
		const { entries } = await f.contents();
		assert.equal(entries.has("code/tree/source/file.ts"), false);
		assert.equal(JSON.parse(entries.get("code/tree/inventory/file.ts")!).state, "deleted");
		assert.doesNotMatch(JSON.stringify([...entries]), /NEW_IGNORED_PRIVATE_TEXT/);
	} finally {
		await f.close();
	}
});

test("synthetic many-path inventory keeps hashing off the event loop (measurement, not a production ceiling guarantee)", async () => {
	const f = await fixture();
	const lag = monitorEventLoopDelay({ resolution: 10 });
	try {
		const bytes = Buffer.alloc(64 * 1024, 65);
		for (let batch = 0; batch < 16; batch++)
			await Promise.all(
				Array.from({ length: 16 }, (_, i) => writeFile(join(f.root, `generated-${batch * 16 + i}.ts`), bytes)),
			);
		const capturer = f.capturer();
		lag.enable();
		const start = performance.now();
		const scan = await (capturer as unknown as ScanSeam).scan(f.workspace, new AbortController().signal);
		const elapsed = performance.now() - start;
		assert.equal(scan.files.length, 259);
		assert.equal(scan.raced, false);
		console.log(
			`synthetic 256x64KiB inventory: ${elapsed.toFixed(1)}ms, event-loop p95 ${(lag.percentile(95) / 1e6).toFixed(1)}ms, RSS ${(process.memoryUsage().rss / 1048576).toFixed(1)}MiB`,
		);
	} finally {
		lag.disable();
		await f.close();
	}
});

test("baseline commit type and object payload hashes are verified, with no HEAD fallback", async () => {
	const f = await fixture();
	try {
		const capturer = f.capturer();
		const tree = await f.git("rev-parse", "HEAD^{tree}");
		await assert.rejects(
			capturer.capture(f.vault, {
				...f.request("tree-is-not-commit"),
				workspace: { ...f.workspace, baseline: tree },
			}),
			/unavailable or over limit/,
		);
		await assert.rejects(
			capturer.capture(f.vault, {
				...f.request("missing-object"),
				workspace: { ...f.workspace, baseline: "a".repeat(40) },
			}),
			/unavailable or over limit/,
		);
		const payload = Buffer.from(`tree ${tree}\n\nForged starting commit\n`);
		await chmod(
			join(f.workspace.gitDirectory, "objects", f.workspace.baseline.slice(0, 2), f.workspace.baseline.slice(2)),
			0o600,
		);
		await writeFile(
			join(f.workspace.gitDirectory, "objects", f.workspace.baseline.slice(0, 2), f.workspace.baseline.slice(2)),
			deflateSync(Buffer.concat([Buffer.from(`commit ${payload.length}\0`), payload])),
		);
		await assert.rejects(capturer.capture(f.vault, f.request()), /unavailable or over limit/);
		assert.equal(await f.store.get("evidence", "capture"), undefined);
	} finally {
		await f.close();
	}
});

test("nested verified baseline trees, renames and gitlinks retain source/deletion/omission inventories", async () => {
	const f = await fixture();
	try {
		await mkdir(join(f.root, "nested", "deeper"), { recursive: true });
		await writeFile(join(f.root, "nested", "deeper", "old.ts"), "nested baseline\n");
		await symlink("../file.ts", join(f.root, "nested", "link"));
		await f.git("add", "nested");
		await f.git("update-index", "--add", "--cacheinfo", `160000,${f.workspace.baseline},module`);
		await f.git("commit", "-m", "Nested synthetic baseline");
		f.workspace.baseline = await f.git("rev-parse", "HEAD");
		await f.git("mv", "nested/deeper/old.ts", "nested/deeper/new.ts");
		await f.capturer().capture(f.vault, f.request());
		const { entries, manifest } = await f.contents();
		assert.equal(entries.get("code/baseline/source/nested/deeper/old.ts"), "nested baseline\n");
		assert.equal(entries.get("code/tree/source/nested/deeper/new.ts"), "nested baseline\n");
		assert.equal(JSON.parse(entries.get("code/tree/inventory/nested/deeper/old.ts")!).state, "deleted");
		assert.equal(JSON.parse(entries.get("code/baseline/inventory/module")!).mode, "160000");
		assert.equal(JSON.parse(entries.get("code/tree/inventory/module")!).state, "unsupported");
		assert.equal(entries.has("code/baseline/source/module"), false);
		assert.equal(entries.has("code/baseline/source/nested/link"), false);
		assert.equal(manifest.complete, false);
	} finally {
		await f.close();
	}
});

test("missing skip-worktree paths are unavailable rather than deletion evidence", async () => {
	const f = await fixture();
	try {
		await f.git("update-index", "--skip-worktree", "file.ts");
		await rm(join(f.root, "file.ts"));
		await f.capturer().capture(f.vault, f.request());
		assert.equal(JSON.parse((await f.contents()).entries.get("code/tree/inventory/file.ts")!).state, "unsupported");
	} finally {
		await f.close();
	}
});
