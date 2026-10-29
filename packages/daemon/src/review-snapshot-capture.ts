/** Read-only capture of an explicitly pinned comparison. Runs in the snapshot worker. */
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readCodeGit } from "./critical-review-code-tree.ts";
import { jjRepositoryIdentity } from "./jj-ownership.ts";
import type { JjOwnedChange } from "./jj-ownership-contract.ts";
import {
	REVIEW_SNAPSHOT_LIMITS as limits,
	type ReviewCaptureRequest,
	type ReviewChange,
	type ReviewSnapshotManifest,
	type ReviewSourceEntry,
	reviewPath,
} from "./review-snapshot-contract.ts";
import { run } from "./workspaces.ts";

export const snapshotHash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const decode = (value: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(value);
const gitHash = (type: string, bytes: Buffer) =>
	createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");

export interface CapturedReview {
	manifest: ReviewSnapshotManifest;
	content: Map<string, Buffer>;
}

export async function captureReview(
	request: ReviewCaptureRequest,
	provenance: ReviewSnapshotManifest["provenance"],
	signal: AbortSignal,
): Promise<CapturedReview> {
	const content = new Map<string, Buffer>();
	const manifest: ReviewSnapshotManifest = {
		version: 1,
		request,
		provenance,
		status: "complete",
		omissions: [],
		before: [],
		after: [],
		changes: [],
		trees: null,
		diff: null,
	};
	const omit = (reason: string) => {
		manifest.omissions.push(reason);
		manifest.status = "partial";
	};
	const ledger: JjOwnedChange = provenance.ledger;
	if (
		ledger.ownership.status !== "owned" ||
		ledger.repositoryId !== request.repositoryId ||
		ledger.changeId !== request.changeId
	)
		throw new Error("Review requires proven worker ownership");
	// Unsaved content is not represented by any pinned commit. Do not even read HEAD or the filesystem.
	if (request.source === "working-copy") {
		manifest.status = "unavailable";
		manifest.omissions.push("Coherent working-copy capture is unsupported; no unsaved content was captured.");
		return { manifest, content };
	}
	const root = ledger.ownership.binding.repositoryPath;
	if ((await realpath(root)) !== root || (await jjRepositoryIdentity(root)) !== request.repositoryId)
		throw new Error("Review repository instance mismatch");
	const gitDirectory = join(root, ".git");
	if (!(await lstat(gitDirectory)).isDirectory() || (await realpath(gitDirectory)) !== gitDirectory)
		throw new Error("Unsafe review object source");
	const target = join(root, ".jj/repo/store/git_target");
	if (
		(await lstat(target)).isSymbolicLink() ||
		(await realpath(resolve(dirname(target), (await readFile(target, "utf8")).trim()))) !== gitDirectory
	)
		throw new Error("Review jj/Git source mismatch");
	const workspace = { root, gitDirectory, baseline: request.base.commitId };
	const git = (args: string[], max = limits.inventoryBytes, input?: string) => {
		signal.throwIfAborted();
		return readCodeGit(workspace, args, max, input, signal);
	};
	let conflicted = false;
	for (const revision of [request.base, request.head]) {
		const observed = await run(
			"jj",
			[
				"--no-pager",
				"--color=never",
				"--ignore-working-copy",
				`--at-op=${request.operationId}`,
				"log",
				"--no-graph",
				"-r",
				revision.commitId,
				"-T",
				'change_id ++ "\\t" ++ commit_id ++ "\\t" ++ conflict',
			],
			root,
			10_000,
			signal,
		);
		if (!observed.startsWith(`${revision.changeId}\t${revision.commitId}\t`) || !/\t(true|false)$/.test(observed))
			throw new Error("Invalid comparison revision/source");
		conflicted ||= observed.endsWith("\ttrue");
	}
	if (conflicted) throw new Error("Conflicted jj comparison unavailable: no complete source representation");
	const commits = await git(
		["cat-file", "--batch"],
		128 * 1024,
		`${request.base.commitId}\n${request.head.commitId}\n`,
	);
	let offset = 0;
	const identities: { tree: string; parents: string[] }[] = [];
	for (const revision of [request.base, request.head]) {
		const end = commits.indexOf(10, offset),
			header = commits.subarray(offset, end).toString("ascii");
		const match = /^([a-f0-9]{40}) commit ([0-9]+)$/.exec(header);
		if (!match || match[1] !== revision.commitId) throw new Error("Missing exact comparison commit");
		const size = Number(match[2]),
			bytes = commits.subarray(end + 1, end + 1 + size);
		if (bytes.length !== size || gitHash("commit", bytes) !== revision.commitId || commits[end + 1 + size] !== 10)
			throw new Error("Invalid comparison object");
		const metadata = bytes.toString("latin1").split("\n\n")[0]!;
		const tree = /^tree ([a-f0-9]{40})\n/.exec(`${metadata}\n`)?.[1];
		if (!tree) throw new Error("Invalid comparison tree");
		identities.push({ tree, parents: [...metadata.matchAll(/^parent ([a-f0-9]{40})$/gm)].map((m) => m[1]!) });
		offset = end + size + 2;
	}
	if (offset !== commits.length) throw new Error("Invalid comparison object framing");
	if (request.scope.kind === "layer") {
		if (!identities[1]!.parents.includes(request.base.commitId))
			throw new Error("Layer base must be an exact head parent");
	} else await git(["merge-base", "--is-ancestor", request.base.commitId, request.head.commitId], 1);
	manifest.trees = { before: identities[0]!.tree, after: identities[1]!.tree };
	let total = 0;
	const tree = async (id: string): Promise<ReviewSourceEntry[]> => {
		let raw: Buffer;
		try {
			raw = await git(["ls-tree", "-r", "-z", "--full-tree", id]);
		} catch {
			signal.throwIfAborted();
			omit(`Tree inventory unavailable or exceeds ${limits.inventoryBytes} bytes: ${id}`);
			return [];
		}
		const records = decode(raw).split("\0");
		if (records.pop() !== "") throw new Error("Invalid tree inventory framing");
		const entries: ReviewSourceEntry[] = [];
		for (const record of records) {
			const match = /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(record);
			if (!match) throw new Error("Unsupported review tree entry");
			const [, mode, , gitOid, path] = match;
			reviewPath(path);
			if (entries.length >= limits.paths) {
				omit(`Tree path limit ${limits.paths}: ${id}`);
				break;
			}
			entries.push({ path, mode: mode!, gitOid: gitOid!, state: "unavailable", sha256: null, bytes: null });
		}
		entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
		const wanted = new Map<string, ReviewSourceEntry[]>();
		for (const entry of entries) {
			signal.throwIfAborted();
			if (entry.mode === "120000" || entry.mode === "160000") {
				entry.reason = entry.mode === "120000" ? "symlink" : "submodule";
				continue;
			}
			const retained = content.get(entry.gitOid);
			if (retained) {
				assign(entry, retained);
				continue;
			}
			const group = wanted.get(entry.gitOid) ?? [];
			group.push(entry);
			wanted.set(entry.gitOid, group);
		}
		const ids = [...wanted.keys()];
		if (!ids.length) return entries;
		// Two bounded batches, not one subprocess per path. Never request oversized blobs.
		try {
			const sizes = (await git(["cat-file", "--batch-check"], ids.length * 128 + 1, `${ids.join("\n")}\n`))
				.toString("ascii")
				.trimEnd()
				.split("\n");
			if (sizes.length !== ids.length) throw new Error("Invalid blob inventory");
			const selected: { oid: string; size: number }[] = [];
			let reserved = 0;
			for (let i = 0; i < ids.length; i++) {
				const oid = ids[i]!,
					group = wanted.get(oid)!;
				const match = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(sizes[i]!);
				if (!match || match[1] !== oid) {
					for (const e of group) e.reason = "object-unavailable";
					continue;
				}
				const size = Number(match[2]);
				if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid blob size");
				for (const e of group) e.bytes = size;
				if (size > limits.blobBytes) {
					for (const e of group) e.reason = "blob-limit";
					continue;
				}
				if (total + reserved + size > limits.bytes) {
					for (const e of group) e.reason = "total-limit";
					continue;
				}
				reserved += size;
				selected.push({ oid, size });
			}
			if (selected.length) {
				const raw = await git(
					["cat-file", "--batch"],
					reserved + selected.length * 128 + 1,
					`${selected.map((e) => e.oid).join("\n")}\n`,
				);
				let offset = 0;
				for (const { oid, size } of selected) {
					signal.throwIfAborted();
					const end = raw.indexOf(10, offset),
						bytes = raw.subarray(end + 1, end + 1 + size);
					if (
						raw.subarray(offset, end).toString("ascii") !== `${oid} blob ${size}` ||
						bytes.length !== size ||
						raw[end + 1 + size] !== 10 ||
						gitHash("blob", bytes) !== oid
					)
						throw new Error("Invalid blob batch identity/framing");
					// Copy each retained blob so a small blob cannot pin a whole batch buffer.
					const retained = Buffer.from(bytes);
					content.set(oid, retained);
					total += size;
					for (const e of wanted.get(oid)!) assign(e, retained);
					offset = end + size + 2;
				}
				if (offset !== raw.length) throw new Error("Invalid blob batch length");
			}
		} catch {
			signal.throwIfAborted();
		}
		for (const group of wanted.values())
			for (const entry of group)
				if (entry.state === "unavailable" && !entry.reason) entry.reason = "object-unavailable";
		return entries;
	};
	function assign(entry: ReviewSourceEntry, bytes: Buffer) {
		entry.bytes = bytes.length;
		entry.sha256 = snapshotHash(bytes);
		try {
			decode(bytes);
			entry.state = bytes.includes(0) ? "binary" : "text";
		} catch {
			entry.state = "binary";
		}
	}
	manifest.before = await tree(identities[0]!.tree);
	manifest.after = await tree(identities[1]!.tree);
	const pair = [request.base.commitId, request.head.commitId];
	try {
		const raw = await git([
			"diff-tree",
			"--no-commit-id",
			"--no-ext-diff",
			"--no-textconv",
			"-r",
			"-z",
			"--raw",
			"--full-index",
			"--no-abbrev",
			"--find-renames=50%",
			"-l1000",
			...pair,
			"--",
		]);
		manifest.changes = changes(raw);
	} catch {
		signal.throwIfAborted();
		omit("Changed-path/rename inventory unavailable or exceeds limit.");
	}
	try {
		const bytes = await git(
			[
				"-c",
				"core.quotePath=true",
				"diff",
				"--no-ext-diff",
				"--no-textconv",
				"--no-color",
				"--no-relative",
				"--full-index",
				"--find-renames=50%",
				"-l1000",
				"--submodule=short",
				"--src-prefix=a/",
				"--dst-prefix=b/",
				"--unified=3",
				"--inter-hunk-context=0",
				"--diff-algorithm=myers",
				"--no-indent-heuristic",
				"-O/dev/null",
				"--ignore-submodules=none",
				...pair,
				"--",
			],
			limits.diffBytes,
		);
		const sha256 = snapshotHash(bytes);
		content.set(`diff:${sha256}`, bytes);
		manifest.diff = { sha256, bytes: bytes.length };
	} catch {
		signal.throwIfAborted();
		omit(`Raw diff unavailable or exceeds ${limits.diffBytes} bytes.`);
	}
	for (const side of ["before", "after"] as const) {
		const unavailable = manifest[side].filter((e) => e.state === "unavailable");
		if (unavailable.length) omit(`${side}: ${unavailable.length} unavailable source entries; see entry reasons.`);
	}
	return { manifest, content };
}

function changes(raw: Buffer): ReviewChange[] {
	const fields = decode(raw).split("\0"),
		result: ReviewChange[] = [];
	if (fields.pop() !== "") throw new Error("Invalid raw change framing");
	for (let i = 0; i < fields.length; ) {
		const match = /^:([0-9]{6}) ([0-9]{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([ADMT]|R[0-9]{1,3})$/.exec(fields[i++]!);
		if (!match) throw new Error("Invalid raw change inventory");
		const path = fields[i++];
		reviewPath(path);
		const status = match[5]!,
			afterPath = status.startsWith("R") ? fields[i++] : path;
		reviewPath(afterPath);
		result.push({
			status,
			beforePath: status === "A" ? null : path,
			afterPath: status === "D" ? null : afterPath,
			beforeMode: match[1]!,
			afterMode: match[2]!,
			beforeOid: match[3]!,
			afterOid: match[4]!,
		});
	}
	return result;
}
