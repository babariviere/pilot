import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CriticalReviewStore } from "./critical-review-store.ts";
import {
	CriticalReviewVault,
	REVIEW_VAULT_LIMITS,
	type ReviewCapture,
	type ReviewSelection,
} from "./critical-review-vault.ts";

async function fixture() {
	const home = await realpath(await mkdtemp(join(tmpdir(), "review-vault-")));
	const store = new CriticalReviewStore(join(home, "db", "records.sqlite"));
	const vault = new CriticalReviewVault(join(home, "vault"), store);
	const capture = (selections: ReviewSelection[], id = "manifest"): ReviewCapture => ({
		id,
		projectId: "project",
		hostId: "host",
		sourceIds: ["source"],
		createdAt: 100,
		selections,
		knownSecrets: ["fixture-secret"],
	});
	return {
		home,
		store,
		vault,
		capture,
		close: async () => {
			await store.close();
			await rm(home, { recursive: true, force: true });
		},
	};
}
const selection = (selectionId: string, text = "hello"): ReviewSelection => ({
	selectionId,
	sourceId: "source",
	label: `src/${selectionId}.ts`,
	selected: true,
	category: "source",
	bytes: Buffer.from(text),
});

test("sealed IDs, private bytes, no live paths, secret/unselected/binary omissions", async () => {
	const f = await fixture();
	try {
		const manifest = await f.vault.capture(
			f.capture([
				selection("safe"),
				{ ...selection("unselected"), selected: false, file: { root: "/never/open", relative: "file" } },
				{ ...selection("env"), label: ".env.local" },
				selection("known", "fixture-secret"),
				selection("token", `ghp_${"a".repeat(36)}`),
				{ ...selection("binary"), bytes: Buffer.from([0, 255]) },
			]),
		);
		assert.equal(manifest.entries.length, 1);
		assert.equal(manifest.complete, false);
		assert.deepEqual(
			manifest.omissions.map((item) => item.reason),
			["unselected", "secret", "secret", "secret", "binary"],
		);
		const entry = manifest.entries[0]!;
		assert.deepEqual(await f.vault.read(manifest.id, entry.blobId), { text: "hello" });
		assert.equal(JSON.stringify(manifest).includes(f.home), false);
		assert.equal((await stat(join(f.home, "vault"))).mode & 0o777, 0o700);
		assert.equal((await stat(join(f.home, "vault", manifest.id, entry.blobId))).mode & 0o777, 0o600);
		await assert.rejects(f.vault.read(manifest.id, "other"), /outside/);
		await assert.rejects(f.vault.read("../manifest", entry.blobId), /Invalid/);
		await assert.rejects(f.vault.capture(f.capture([selection("safe")])), /sealed/);
	} finally {
		await f.close();
	}
});

test("host selection rejects traversal, directory/file symlinks and secret files before reads", async () => {
	const f = await fixture();
	try {
		const source = join(f.home, "source");
		await mkdir(source);
		await writeFile(join(source, "safe.ts"), "selected source");
		await symlink(source, join(source, "link"));
		await symlink(join(source, "safe.ts"), join(source, "alias.ts"));
		const manifest = await f.vault.capture(
			f.capture(
				["safe.ts", "../source/safe.ts", "link/safe.ts", "alias.ts", ".env", "/etc/passwd"].map((path, n) => ({
					...selection(`s${n}`),
					bytes: undefined,
					file: { root: source, relative: path },
				})),
			),
		);
		assert.equal(manifest.entries.length, 1);
		assert.equal((await f.vault.read(manifest.id, manifest.entries[0]!.blobId)).text, "selected source");
		assert.equal(manifest.omissions.length, 5);
		assert.equal(manifest.omissions.find((item) => item.selectionId === "s4")!.reason, "secret");
	} finally {
		await f.close();
	}
});

test("blob/guidance/read/path limits are explicit and paginated", async () => {
	const f = await fixture();
	try {
		const manifest = await f.vault.capture(
			f.capture([
				{ ...selection("large"), bytes: Buffer.alloc(REVIEW_VAULT_LIMITS.blobBytes + 1, 97) },
				{
					...selection("guidance"),
					category: "guidance",
					bytes: Buffer.alloc(REVIEW_VAULT_LIMITS.guidanceBytes + 1, 97),
				},
				selection("safe", "abcdef"),
			]),
		);
		assert.deepEqual(
			manifest.omissions.map((x) => x.reason),
			["quota", "quota"],
		);
		const blob = manifest.entries[0]!.blobId;
		assert.deepEqual(await f.vault.read(manifest.id, blob, 0, 3), { text: "abc", next: 3 });
		assert.deepEqual(await f.vault.read(manifest.id, blob, 3, 3), { text: "def" });
		await assert.rejects(f.vault.read(manifest.id, blob, 0, 51201), /page/);
		await assert.rejects(
			f.vault.capture(
				f.capture(
					Array.from({ length: 20001 }, () => selection("x")),
					"over",
				),
			),
			/Invalid/,
		);
	} finally {
		await f.close();
	}
});

test("failed seal cleans staged bytes; modified/deleted blobs never fall back to live data", async () => {
	const f = await fixture();
	try {
		await assert.rejects(f.vault.capture(f.capture([selection("same"), selection("same")])), /identity/);
		assert.deepEqual(await readdir(join(f.home, "vault")), []);
		const manifest = await f.vault.capture(f.capture([selection("safe")]));
		const blob = manifest.entries[0]!.blobId;
		await writeFile(join(f.home, "vault", manifest.id, blob), "other");
		await assert.rejects(f.vault.read(manifest.id, blob), /digest/);
		await Promise.all([
			rm(join(f.home, "vault", manifest.id), { recursive: true, force: true }),
			f.vault.read(manifest.id, blob).catch(() => undefined),
		]);
		await assert.rejects(f.vault.read(manifest.id, blob));
		assert.equal(
			(await readFile(join(f.home, "db", "records.sqlite"))).includes(Buffer.from("fixture-secret")),
			false,
		);
	} finally {
		await f.close();
	}
});
