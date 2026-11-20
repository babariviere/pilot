import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { deflate } from "node:zlib";
import { ReadOnlyPRCapture, type ReviewPRCaptureRequest } from "./critical-review-pr-capture.ts";
import {
	canonicalReviewPRIdentity,
	pinReviewPR,
	type ReviewGitObjectType,
	ReviewPRCaptureError,
	type ReviewPRReader,
	type ReviewPRSnapshot,
} from "./critical-review-pr-intake.ts";
import { REVIEW_PR_LIMITS, type ReviewPRLimits, ReviewPRObjects, ReviewPRScope } from "./critical-review-pr-objects.ts";
import { CriticalReviewStore } from "./critical-review-store.ts";
import { CriticalReviewVault } from "./critical-review-vault.ts";

const execute = promisify(execFile),
	compress = promisify(deflate);
const repository = { id: "R_target", owner: "example", name: "project" };
const fork = { id: "R_fork", owner: "colleague", name: "project-fork" };
const identity = {
	host: "github.example",
	account: { id: "U_viewer", login: "viewer" },
	repository,
	pr: { id: "PR_42", number: 42 },
};
const failure = (code: ReviewPRCaptureError["code"]) => (error: unknown) =>
	error instanceof ReviewPRCaptureError && error.code === code;
type File = string | { mode: string; oid: string };

/** Synthetic loose-object repository. No init/checkout/fetch, account, git config discovery or network. */
async function fixture() {
	const home = await realpath(await mkdtemp(join(tmpdir(), "pr-capture-test-")));
	const source = join(home, "source.git");
	await mkdir(join(source, "objects"), { recursive: true });
	await mkdir(join(source, "refs", "heads"), { recursive: true });
	await writeFile(join(source, "config"), "[core]\nrepositoryformatversion = 0\nbare = true\n");
	await writeFile(join(source, "HEAD"), "ref: refs/heads/author\n");
	const records = new Map<string, { type: ReviewGitObjectType; bytes: Buffer }>();
	async function object(type: ReviewGitObjectType, value: string | Buffer) {
		const bytes = Buffer.from(value),
			header = Buffer.from(`${type} ${bytes.length}\0`);
		const oid = createHash("sha1").update(header).update(bytes).digest("hex");
		records.set(oid, { type, bytes });
		await mkdir(join(source, "objects", oid.slice(0, 2)), { recursive: true });
		await writeFile(
			join(source, "objects", oid.slice(0, 2), oid.slice(2)),
			await compress(Buffer.concat([header, bytes])),
		);
		return oid;
	}
	async function tree(files: Record<string, File>): Promise<string> {
		const nodes = new Map<string, Record<string, File>>(),
			entries: { name: string; mode: string; oid: string }[] = [];
		for (const [path, value] of Object.entries(files)) {
			const slash = path.indexOf("/");
			if (slash < 0)
				entries.push({
					name: path,
					mode: typeof value === "string" ? "100644" : value.mode,
					oid: typeof value === "string" ? await object("blob", value) : value.oid,
				});
			else {
				const name = path.slice(0, slash),
					children = nodes.get(name) ?? {};
				children[path.slice(slash + 1)] = value;
				nodes.set(name, children);
			}
		}
		for (const [name, children] of nodes) entries.push({ name, mode: "40000", oid: await tree(children) });
		entries.sort((a, b) =>
			Buffer.compare(
				Buffer.from(a.name + (a.mode === "40000" ? "/" : "")),
				Buffer.from(b.name + (b.mode === "40000" ? "/" : "")),
			),
		);
		return object(
			"tree",
			Buffer.concat(
				entries.map((e) => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.oid, "hex")])),
			),
		);
	}
	let serial = 0;
	async function commit(files: Record<string, File>, parents: string[] = []) {
		return object(
			"commit",
			`tree ${await tree(files)}\n${parents.map((p) => `parent ${p}\n`).join("")}author Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nSynthetic ${serial++}\n`,
		);
	}
	const root = await commit({ "src/code.ts": "initial\n", "shared.ts": "surrounding source\n" });
	const stack = await commit({ "src/code.ts": "stack change\n", "shared.ts": "surrounding source\n" }, [root]);
	const head = await commit({ "src/code.ts": "stack change\nhead change\n", "shared.ts": "surrounding source\n" }, [
		stack,
	]);
	const base = await commit(
		{ "src/code.ts": "initial\n", "shared.ts": "surrounding source\n", "target-only.ts": "upstream\n" },
		[root],
	);
	await writeFile(join(source, "refs", "heads", "author"), `${head}\n`);
	let metadata: ReviewPRSnapshot = {
		...identity,
		head: { oid: head, repository: fork, ref: "feature" },
		base: { oid: base, repository, ref: "release/stack-target" },
	};
	const calls: { oid: string; repositoryId: string }[] = [];
	let metadataCalls = 0;
	const reader: ReviewPRReader = {
		readPullRequest: async (request) => {
			assert.deepEqual(request.identity, identity);
			assert.ok(request.maxBytes <= REVIEW_PR_LIMITS.metadataBytes);
			metadataCalls++;
			return structuredClone(metadata);
		},
		readObject: async (request) => {
			assert.deepEqual(request.identity, identity);
			assert.ok(request.maxBytes <= REVIEW_PR_LIMITS.objectBytes);
			calls.push({ oid: request.oid, repositoryId: request.repository.id });
			const record = records.get(request.oid);
			if (!record) throw new Error("synthetic missing object");
			return {
				host: identity.host,
				accountId: identity.account.id,
				repositoryId: request.repository.id,
				type: record.type,
				bytes: Uint8Array.from(record.bytes),
			};
		},
	};
	const store = new CriticalReviewStore(join(home, "db", "records.sqlite"), () => 100);
	const vault = new CriticalReviewVault(join(home, "vault"), store);
	const request = (id = "capture"): ReviewPRCaptureRequest => ({
		id,
		projectId: "project",
		hostId: "host",
		createdAt: 100,
		identity: structuredClone(identity),
		knownSecrets: ["known-fixture-secret"],
	});
	const capture = (adapter = reader, limits: Partial<ReviewPRLimits> = {}) =>
		new ReadOnlyPRCapture(vault, adapter, limits);
	const nativeDiff = async (from: string, to: string) =>
		(
			await execute(
				"/usr/bin/git",
				[
					"--no-pager",
					"-c",
					"core.attributesFile=/dev/null",
					`--git-dir=${source}`,
					"diff",
					"--no-ext-diff",
					"--no-textconv",
					"--no-renames",
					"--full-index",
					"--no-indent-heuristic",
					"--diff-algorithm=myers",
					from,
					to,
					"--",
				],
				{
					env: {
						PATH: "/usr/bin:/bin",
						HOME: home,
						GIT_CONFIG_NOSYSTEM: "1",
						GIT_CONFIG_GLOBAL: "/dev/null",
						LC_ALL: "C",
					},
					maxBuffer: 10 * 1024 * 1024,
				},
			)
		).stdout;
	const text = async (manifestId: string, label: string) => {
		const manifest = await vault.manifest(manifestId),
			entry = manifest.entries.find((e) => e.label === label);
		assert.ok(entry, `missing ${label}`);
		return (await vault.read(manifestId, entry.blobId)).text;
	};
	return {
		home,
		source,
		records,
		reader,
		calls,
		store,
		vault,
		request,
		capture,
		object,
		tree,
		commit,
		root,
		stack,
		head,
		base,
		nativeDiff,
		text,
		get metadata() {
			return metadata;
		},
		set metadata(value: ReviewPRSnapshot) {
			metadata = value;
		},
		get metadataCalls() {
			return metadataCalls;
		},
		close: async () => {
			await store.close();
			await rm(home, { recursive: true, force: true });
		},
	};
}

test("fork intake pins canonical account/repository/PR and exact H/B/M without owning or mutating author refs", async () => {
	const f = await fixture();
	try {
		const before = await readFile(join(f.source, "refs", "heads", "author"), "utf8");
		const { manifest, snapshot } = await f.capture().capture(f.request());
		assert.equal(snapshot.head.oid, f.head);
		assert.equal(snapshot.base.oid, f.base);
		assert.equal(snapshot.mergeBase, f.root);
		assert.deepEqual(snapshot.head.repository, fork);
		assert.equal(snapshot.base.ref, "release/stack-target");
		assert.ok(f.calls.some((c) => c.oid === f.head && c.repositoryId === fork.id));
		assert.ok(f.calls.some((c) => c.oid === f.base && c.repositoryId === repository.id));
		assert.equal(f.metadataCalls, 2);
		assert.equal(manifest.complete, true);
		assert.equal(await f.text(manifest.id, "pr/diff/src/code.ts"), await f.nativeDiff(f.root, f.head));
		assert.equal(await f.text(manifest.id, "pr/head/shared.ts"), "surrounding source\n");
		const receipt = JSON.parse(await f.text(manifest.id, "pr/capture.json"));
		assert.deepEqual(receipt.snapshot, snapshot);
		assert.equal(receipt.inventoryPaths, 3);
		assert.equal(receipt.changedPaths, 1);
		assert.equal(await readFile(join(f.source, "refs", "heads", "author"), "utf8"), before);
		assert.equal(JSON.stringify(manifest).includes(f.source), false);
		assert.equal(await f.store.get("target", "capture"), undefined);
		await rm(f.source, { recursive: true });
		f.records.clear();
		assert.equal(await f.text(manifest.id, "pr/head/shared.ts"), "surrounding source\n");
	} finally {
		await f.close();
	}
});

test("stack target is used exactly, never main or PR patch API", async () => {
	const f = await fixture();
	try {
		f.metadata = { ...f.metadata, base: { ...f.metadata.base, oid: f.stack, ref: "feature-parent" } };
		const { snapshot, manifest } = await f.capture().capture(f.request());
		assert.equal(snapshot.mergeBase, f.stack);
		const patch = await f.text(manifest.id, "pr/diff/src/code.ts");
		assert.equal(patch, await f.nativeDiff(f.stack, f.head));
		assert.ok(!patch.includes("+stack change"));
	} finally {
		await f.close();
	}
});

test("intake canonicalizes names but rejects identity swaps, deleted/ambiguous bases and malformed OIDs", () => {
	assert.deepEqual(
		canonicalReviewPRIdentity({
			...identity,
			host: "GitHub.Example",
			account: { ...identity.account, login: "Viewer" },
			repository: { ...repository, owner: "Example", name: "Project" },
		}),
		identity,
	);
	const snapshot = {
		...identity,
		head: { oid: "a".repeat(40), repository: fork, ref: "feature" },
		base: { oid: "b".repeat(40), repository, ref: "release" },
	};
	for (const patch of [
		{ host: "other.example" },
		{ account: { ...identity.account, id: "U_other" } },
		{ repository: { ...repository, id: "R_other" } },
		{ pr: { ...identity.pr, number: 43 } },
		{ pr: { ...identity.pr, id: "PR_other" } },
	])
		assert.throws(() => pinReviewPR(identity, { ...snapshot, ...patch }), failure("identity"));
	for (const base of [
		null,
		[],
		[snapshot.base, snapshot.base],
		{ ...snapshot.base, oid: null },
		{ ...snapshot.base, ref: "" },
		{ ...snapshot.base, oid: "main" },
		{ ...snapshot.base, repository: fork },
	])
		assert.throws(() => pinReviewPR(identity, { ...snapshot, base }), failure("base"));
	for (const host of ["https://github.example", "github.example/path", "github.example:443", "github..example"])
		assert.throws(() => canonicalReviewPRIdentity({ ...identity, host }), failure("identity"));
});

test("missing/forged/wrong-type objects fail closed before sealing", async () => {
	const f = await fixture();
	try {
		for (const kind of [
			"missing-head",
			"missing-parent",
			"missing-tree",
			"missing-blob",
			"forged",
			"type",
			"account",
			"repository",
			"host",
		]) {
			const adapter: ReviewPRReader = {
				...f.reader,
				readObject: async (r) => {
					if (
						(kind === "missing-head" && r.oid === f.head) ||
						(kind === "missing-parent" && r.oid === f.stack) ||
						(kind === "missing-tree" && r.type === "tree") ||
						(kind === "missing-blob" && r.type === "blob")
					)
						throw new Error("missing");
					const response = await f.reader.readObject(r);
					if (kind === "forged") response.bytes = Buffer.from("forged");
					if (kind === "type") response.type = "blob";
					if (kind === "account") response.accountId = "other";
					if (kind === "repository") response.repositoryId = "other";
					if (kind === "host") response.host = "other.example";
					return response;
				},
			};
			await assert.rejects(
				f.capture(adapter).capture(f.request(kind)),
				failure(["account", "repository", "host"].includes(kind) ? "identity" : "object"),
			);
			assert.equal(await f.store.get("evidence", kind), undefined);
		}
	} finally {
		await f.close();
	}
});

test("unrelated and criss-cross histories do not invent a merge base", async () => {
	const f = await fixture();
	try {
		const unrelated = await f.commit({ "independent.ts": "independent" });
		f.metadata = { ...f.metadata, base: { ...f.metadata.base, oid: unrelated } };
		await assert.rejects(f.capture().capture(f.request("unrelated")), failure("ancestry"));
		const left = await f.commit({ a: "left" }, [f.root]),
			right = await f.commit({ a: "right" }, [f.root]);
		const x = await f.commit({ a: "x" }, [left, right]),
			y = await f.commit({ a: "y" }, [right, left]);
		f.metadata = { ...f.metadata, head: { ...f.metadata.head, oid: x }, base: { ...f.metadata.base, oid: y } };
		await assert.rejects(f.capture().capture(f.request("ambiguous")), failure("ancestry"));
	} finally {
		await f.close();
	}
});

test("tip, account or deleted-target changes during capture are rejected, never retargeted", async () => {
	const f = await fixture();
	try {
		for (const mode of ["head", "base", "account", "deleted"]) {
			let reads = 0;
			const adapter: ReviewPRReader = {
				...f.reader,
				readPullRequest: async (r) => {
					const result = structuredClone(await f.reader.readPullRequest(r)) as ReviewPRSnapshot;
					if (++reads === 2) {
						if (mode === "head") result.head.oid = f.stack;
						if (mode === "base") result.base.oid = f.root;
						if (mode === "account") result.account.id = "U_switched";
						if (mode === "deleted") return { ...result, base: null };
					}
					return result;
				},
			};
			await assert.rejects(
				f.capture(adapter).capture(f.request(mode)),
				failure(mode === "account" ? "identity" : mode === "deleted" ? "base" : "changed"),
			);
			assert.equal(await f.store.get("evidence", mode), undefined);
		}
	} finally {
		await f.close();
	}
});

test("object, aggregate, path, diff and metadata quotas fail without partial sealing", async () => {
	const f = await fixture();
	try {
		const limits: Partial<ReviewPRLimits>[] = [
			{ objects: 1 },
			{ objectBytes: 1 },
			{ bytes: 300 },
			{ paths: 1 },
			{ diffBytes: 1 },
			{ metadataBytes: 1 },
		];
		for (const [index, limit] of limits.entries()) {
			await assert.rejects(f.capture(f.reader, limit).capture(f.request(`quota-${index}`)), failure("quota"));
			assert.equal(await f.store.get("evidence", `quota-${index}`), undefined);
		}
		assert.throws(() => f.capture(f.reader, { diffBytes: REVIEW_PR_LIMITS.diffBytes + 1 }), failure("quota"));
	} finally {
		await f.close();
	}
});

test("cancellation and per-read deadlines suppress late adapter output; admission is bounded", async () => {
	const f = await fixture();
	try {
		const aborted = new AbortController();
		aborted.abort();
		await assert.rejects(
			f.capture().capture({ ...f.request("early"), signal: aborted.signal }),
			failure("cancelled"),
		);
		assert.equal(f.metadataCalls, 0);
		let release!: () => void, started!: () => void;
		const barrier = new Promise<void>((resolve) => {
				release = resolve;
			}),
			ready = new Promise<void>((resolve) => {
				started = resolve;
			});
		const controller = new AbortController();
		const adapter: ReviewPRReader = {
			...f.reader,
			readObject: async (r) => {
				started();
				await barrier;
				return f.reader.readObject(r);
			},
		};
		const capture = f.capture(adapter),
			pending = capture.capture({ ...f.request("cancelled"), signal: controller.signal });
		await ready;
		await assert.rejects(capture.capture(f.request("busy")), failure("busy"));
		controller.abort();
		await assert.rejects(pending, failure("cancelled"));
		release();
		await barrier;
		assert.equal(await f.store.get("evidence", "cancelled"), undefined);
		const never: ReviewPRReader = { ...f.reader, readPullRequest: async () => new Promise(() => {}) };
		await assert.rejects(f.capture(never, { readMs: 20 }).capture(f.request("timeout")), failure("timeout"));
		// A cancelled instance is reusable, but no interrupted request is replayed automatically.
		assert.equal((await capture.capture(f.request("retry"))).manifest.complete, true);
	} finally {
		await f.close();
	}
});

test("cancellation during atomic vault seal revokes the late manifest and releases staging", async () => {
	const f = await fixture();
	try {
		const controller = new AbortController(),
			seal = f.vault.capture.bind(f.vault);
		f.vault.capture = async (input) => {
			const result = await seal(input);
			controller.abort();
			return result;
		};
		await assert.rejects(f.capture().capture({ ...f.request(), signal: controller.signal }), failure("cancelled"));
		assert.equal(await f.store.get("evidence", "capture"), undefined);
		assert.deepEqual(await readdir(join(f.home, "vault")), []);
	} finally {
		await f.close();
	}
});

test("ambient Git commands/config/hooks/textconv are ignored, only private object data is used", async () => {
	const f = await fixture();
	const old = { ...process.env };
	try {
		const marker = join(f.home, "EXECUTED"),
			evil = join(f.home, "evil-config");
		await writeFile(
			evil,
			`[diff]\nexternal = touch ${marker}\n[diff "evil"]\ntextconv = touch ${marker}\n[core]\nhooksPath = ${f.home}\nfsmonitor = touch ${marker}\n`,
		);
		await writeFile(join(f.home, "post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
		process.env.GIT_EXTERNAL_DIFF = `touch ${marker}`;
		process.env.GIT_CONFIG_GLOBAL = evil;
		process.env.GIT_CONFIG_SYSTEM = evil;
		process.env.GIT_OBJECT_DIRECTORY = "/not/a/repository";
		process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = "/not/a/repository";
		process.env.GIT_SHALLOW_FILE = "/not/a/file";
		process.env.GIT_CONFIG_COUNT = "1";
		process.env.GIT_CONFIG_KEY_0 = "diff.external";
		process.env.GIT_CONFIG_VALUE_0 = `touch ${marker}`;
		process.env.HOME = f.home;
		process.env.PATH = "/not/a/bin";
		const result = await f.capture().capture(f.request());
		assert.equal(result.manifest.complete, true);
		await assert.rejects(access(marker));
		assert.equal(await readFile(join(f.source, "refs", "heads", "author"), "utf8"), `${f.head}\n`);
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
		Object.assign(process.env, old);
		await f.close();
	}
});

test("canonical per-path patches match whole M→H diff including file/directory replacement and literal paths", async () => {
	const f = await fixture();
	try {
		const old = await f.commit({ a: "old\n", "delete.ts": "removed\n", "[glob]*.ts": "before\n" });
		const head = await f.commit({ "a/file.ts": "new\n", "[glob]*.ts": "after\n", "added.ts": "new\n" }, [old]);
		f.metadata = { ...f.metadata, head: { ...f.metadata.head, oid: head }, base: { ...f.metadata.base, oid: old } };
		const { manifest } = await f.capture().capture(f.request());
		let patch = "";
		for (const entry of manifest.entries.filter((e) => e.label.startsWith("pr/diff/")))
			patch += (await f.vault.read(manifest.id, entry.blobId)).text;
		assert.equal(patch, await f.nativeDiff(old, head));
	} finally {
		await f.close();
	}
});

test("binary, secret, symlink, gitlink and LFS cases retain explicit limited coverage, never execute or hydrate", async () => {
	const f = await fixture();
	try {
		const binary = await f.object("blob", Buffer.from([0, 1, 255])),
			symlink = await f.object("blob", "/etc/passwd");
		const head = await f.commit(
			{
				".env": "PASSWORD=private\n",
				"known.ts": "known-fixture-secret\n",
				"binary.dat": { mode: "100644", oid: binary },
				link: { mode: "120000", oid: symlink },
				submodule: { mode: "160000", oid: "d".repeat(40) },
				"lfs.dat": `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 999999999\n`,
				"script.sh": { mode: "100755", oid: await f.object("blob", "#!/bin/sh\nexit 99\n") },
			},
			[f.root],
		);
		f.metadata = { ...f.metadata, head: { ...f.metadata.head, oid: head } };
		const { manifest } = await f.capture().capture(f.request());
		assert.equal(manifest.complete, false);
		for (const reason of ["secret", "binary", "unselected"])
			assert.ok(manifest.omissions.some((o) => o.reason === reason));
		let retained = "";
		for (const entry of manifest.entries) retained += (await f.vault.read(manifest.id, entry.blobId)).text;
		assert.ok(!retained.includes("PASSWORD=private"));
		assert.ok(!retained.includes("known-fixture-secret"));
		assert.ok(!retained.includes(".env"));
		assert.ok(retained.includes("version https://git-lfs.github.com/spec/v1"));
		assert.ok(!f.calls.some((call) => call.oid === "d".repeat(40)));
		assert.equal(await f.text(manifest.id, "pr/head/script.sh"), "#!/bin/sh\nexit 99\n");
		await f.vault.eraseSource(manifest.sourceIds[2]!);
		await assert.rejects(f.vault.manifest(manifest.id));
	} finally {
		await f.close();
	}
});

test("non-cooperative cancelled reads retain their slots until settled, never accumulate unbounded transport work", async () => {
	const f = await fixture();
	const releases: Array<() => void> = [];
	try {
		let calls = 0;
		const reader: ReviewPRReader = {
			...f.reader,
			readPullRequest: async (r) => {
				calls++;
				await new Promise<void>((resolve) => releases.push(resolve));
				return f.reader.readPullRequest(r);
			},
		};
		const capture = f.capture(reader, { readMs: 20 });
		for (let index = 0; index < 3; index++)
			await assert.rejects(capture.capture(f.request(`hung-${index}`)), failure("timeout"));
		await assert.rejects(capture.capture(f.request("over-capacity")), failure("busy"));
		assert.equal(calls, 3);
	} finally {
		for (const release of releases) release();
		await f.close();
	}
});

test("project storage quota covers object staging and fails without eviction or leftover capture stages", async () => {
	const f = await fixture();
	try {
		await f.store.rpc("vaultStage", { id: "other-capture", projectId: "project", bytes: 1024 ** 3 });
		await assert.rejects(f.capture().capture(f.request()), failure("quota"));
		assert.deepEqual(await f.store.rpc("stagedCaptures"), [{ id: "other-capture" }]);
		assert.equal(await f.store.get("evidence", "capture"), undefined);
	} finally {
		await f.close();
	}
});

test("private object stages use existing startup recovery, including interruption before sealing", async () => {
	const f = await fixture();
	const scope = new ReviewPRScope(REVIEW_PR_LIMITS);
	try {
		const objects = await ReviewPRObjects.create(scope, identity, f.reader, f.vault, "project");
		await objects.history(f.head, fork);
		const stages = await f.store.rpc<Array<{ id: string }>>("stagedCaptures");
		assert.equal(stages.length, 1);
		assert.ok(stages[0]!.id.startsWith("pr-objects-"));
		assert.ok(objects.root.startsWith(f.vault.root));
		assert.ok(objects.root.endsWith(".part"));
		// Recovery is startup-only: no capture or reader remains live when this runs.
		scope.close();
		await f.vault.recover();
		assert.deepEqual(await f.store.rpc("stagedCaptures"), []);
		assert.deepEqual(await readdir(f.vault.root), []);
	} finally {
		scope.close();
		await f.close();
	}
});

test("tampered cached objects and filtered identity receipts never become usable snapshots", async () => {
	const f = await fixture();
	const scope = new ReviewPRScope(REVIEW_PR_LIMITS);
	try {
		const objects = await ReviewPRObjects.create(scope, identity, f.reader, f.vault, "project");
		try {
			await objects.history(f.head, fork);
			const forged = Buffer.from("commit 6\0forged");
			await writeFile(join(objects.root, "objects", f.head.slice(0, 2), f.head.slice(2)), await compress(forged));
			await assert.rejects(objects.history(f.head, fork), failure("object"));
		} finally {
			await objects.close();
		}
		await assert.rejects(f.capture().capture({ ...f.request(), knownSecrets: ["viewer"] }), failure("identity"));
		assert.equal(await f.store.get("evidence", "capture"), undefined);
		assert.deepEqual(await readdir(f.vault.root), []);
	} finally {
		scope.close();
		await f.close();
	}
});

test("unsafe and malformed trees fail before source or patch publication", async () => {
	const f = await fixture();
	try {
		const blob = await f.object("blob", "untrusted");
		for (const name of ["..", "escape/name", "escape\\name", "line\nbreak"]) {
			const tree = await f.object(
				"tree",
				Buffer.concat([Buffer.from(`100644 ${name}\0`), Buffer.from(blob, "hex")]),
			);
			const head = await f.object(
				"commit",
				`tree ${tree}\nparent ${f.root}\nauthor Fixture <f@example.invalid> 1 +0000\ncommitter Fixture <f@example.invalid> 1 +0000\n\nUnsafe fixture\n`,
			);
			f.metadata = { ...f.metadata, head: { ...f.metadata.head, oid: head } };
			await assert.rejects(f.capture().capture(f.request()), failure("object"));
		}
	} finally {
		await f.close();
	}
});

test("synthetic many-path capture reports elapsed time/RSS and heartbeat gap without touching live work", async (t) => {
	const f = await fixture();
	try {
		const files = Object.fromEntries(
			Array.from({ length: 128 }, (_, i) => [`src/file-${String(i).padStart(3, "0")}.ts`, `${"x".repeat(1024)}\n`]),
		);
		const base = await f.commit(files),
			head = await f.commit({ ...files, "src/file-000.ts": "changed\n" }, [base]);
		f.metadata = { ...f.metadata, head: { ...f.metadata.head, oid: head }, base: { ...f.metadata.base, oid: base } };
		let last = performance.now(),
			gap = 0;
		const timer = setInterval(() => {
			const now = performance.now();
			gap = Math.max(gap, now - last);
			last = now;
		}, 5);
		const start = performance.now(),
			rssBefore = process.memoryUsage().rss;
		try {
			const { manifest } = await f.capture().capture(f.request());
			assert.equal(manifest.complete, true);
			assert.equal(manifest.entries.length, 514);
			t.diagnostic(
				JSON.stringify({
					paths: 128,
					elapsedMs: Math.round(performance.now() - start),
					heartbeatMaxGapMs: Math.round(gap),
					rssBefore,
					rssAfter: process.memoryUsage().rss,
				}),
			);
		} finally {
			clearInterval(timer);
		}
	} finally {
		await f.close();
	}
});
