/** Offline I/O amplification fixture. node scripts/bench/io.ts [baseline-commit]
 * Optional baseline loads changes.ts from that commit, with current subprocess plumbing.
 * Never opens user sessions, providers, extensions, credentials or repository workspaces.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createSession, LiveDoc, UserEntry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { collectChangeSummary } from "../../packages/daemon/src/changes.ts";
import { subprocesses } from "../../packages/daemon/src/subprocess.ts";
import { untrackedStats } from "../../packages/daemon/src/untracked-stats.ts";

const { assignJson } = await import(
	new URL("./harness/json.js", import.meta.resolve("@earendil-works/pi-durable")).href
);
const home = await mkdtemp(join(tmpdir(), "pilot-io-bench-"));
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_OPTIONAL_LOCKS = "0";
const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: home });

try {
	git("init", "--quiet");
	await writeFile(join(home, "tracked.txt"), "fixture\n");
	git("add", ".");
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture");
	const variants = [{ name: "current", collect: collectChangeSummary }];
	const baseline = process.argv[2];
	if (baseline) {
		if (!/^[a-f\d]{6,40}$/.test(baseline)) throw new Error("Baseline must be a commit hash");
		const root = fileURLToPath(new URL("../../", import.meta.url));
		const source = execFileSync("git", ["show", `${baseline}:packages/daemon/src/changes.ts`], {
			cwd: root,
			encoding: "utf8",
		});
		// The original module's relative imports still refer to its helpers in this checkout.
		const patched = source.replaceAll('from "./', `from "${join(root, "packages/daemon/src")}/`);
		const path = join(home, "baseline.ts");
		await writeFile(path, patched);
		const { collectChangeSummary: collect } = await import(pathToFileURL(path).href);
		variants.unshift({ name: `baseline-${baseline}`, collect });
	}
	const run = subprocesses.run.bind(subprocesses);
	let commands = 0;
	subprocesses.run = (...args) => {
		commands++;
		return run(...args);
	};
	// Keep the dynamically loaded module and its SQLite fixtures out of untracked input.
	git("config", "core.excludesFile", "/dev/null");
	await writeFile(join(home, ".git/info/exclude"), "baseline.ts\n*.sqlite*\n");
	for (const count of [0, 100, 1000]) {
		for (let i = 0; i < count; i++) await writeFile(join(home, `new-${i}.txt`), "new line\n".repeat(10));
		for (const variant of variants) {
			if (count === 1000 && variant.name !== "current") continue;
			for (let repeat = 0; repeat < 2; repeat++) {
				commands = 0;
				const bytes = untrackedStats.bytesRead;
				const start = performance.now();
				const summary = await variant.collect(home);
				console.log(
					JSON.stringify({
						workload: "summary",
						variant: variant.name,
						untracked: count,
						repeat,
						commands,
						elapsedMs: Math.round(performance.now() - start),
						scannedBytes: untrackedStats.bytesRead - bytes,
						fileCount: summary.fileCount,
						additions: summary.additions,
					}),
				);
			}
		}
	}
	await subprocesses.close();
	await untrackedStats.close();
	for (const kind of ["model", "tool"] as const) {
		for (const interval of [100, 250]) {
			const file = join(home, `${kind}-${interval}.sqlite`);
			// Count appended WAL frames without reuse. This is not physical device throughput.
			const storage = await openNodeSqliteStorage(file, { walAutoCheckpointPages: 100_000 });
			const session = createSession(storage);
			try {
				const conversation = await session.commit(async (tx) => {
					const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
					for (let i = 0; i < 1000; i++)
						await tx.appendEntry(UserEntry, conversation.id, {
							model: [{ role: "user", content: `Historical message ${i}`, timestamp: i }],
						});
					const live = await tx.doc(LiveDoc, conversation.id);
					if (kind === "model") live.generation = { attempt: 1 };
					else live.tools = [{ callId: "fixture", name: "fixture", status: "running" }];
					return conversation;
				}, context);
				const before = (await stat(`${file}-wal`)).size;
				const frames = 60_000 / interval;
				const start = performance.now();
				for (let i = 1; i <= frames; i++) {
					const text = "x".repeat(Math.round((30_720 * i) / frames));
					await session.commit(async (tx) => {
						const live = await tx.doc(LiveDoc, conversation.id);
						if (kind === "model")
							assignJson(live.generation, "message", fauxAssistantMessage(text, { timestamp: 1 }));
						else live.tools![0]!.output = text;
					}, context);
				}
				const walBytes = (await stat(`${file}-wal`)).size - before;
				const db = new DatabaseSync(file, { readOnly: true });
				const revisions = db
					.prepare("SELECT COUNT(*) AS n,SUM(length(CAST(content AS BLOB))) AS bytes FROM document_revisions")
					.get();
				db.close();
				console.log(
					JSON.stringify({
						workload: "progress",
						kind,
						historyEntries: 1000,
						equivalentSeconds: 60,
						interval,
						commits: frames,
						finalTextBytes: 30_720,
						walBytes,
						revisions,
						elapsedMs: Math.round(performance.now() - start),
					}),
				);
			} finally {
				await session.close(context);
			}
		}
	}
} finally {
	await subprocesses.close();
	await untrackedStats.close();
	await rm(home, { recursive: true, force: true });
}
