/**
 * Reopen benchmark: fork a kernel worker on a copy of an existing session and time
 * spawn -> ready -> first snapshot, alternating the current entry with the previous tsx-loaded one.
 *   node scripts/bench/reopen.ts <session-dir> [runs]
 * Never point it at a live session's storage: it copies the durable directory first.
 */
import { fork } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { workerEntry } from "@pilot/kernel";

const [sessionDir, runsArg] = process.argv.slice(2);
if (!sessionDir) throw new Error("usage: reopen.ts <session-dir> [runs]");
const meta = JSON.parse(await readFile(join(sessionDir, "meta.json"), "utf8"));
const runs = Number(runsArg ?? 3);

type Variant = "tsx" | "native" | "spare";

async function once(variant: Variant): Promise<Record<string, number>> {
	const home = await mkdtemp(join(tmpdir(), "pilot-bench-"));
	await cp(join(sessionDir, "durable"), join(home, "durable"), { recursive: true });
	let start = performance.now();
	const marks: Record<string, number> = {};
	const entry = variant === "tsx" ? new URL("./worker.ts", workerEntry) : workerEntry;
	const child = fork(fileURLToPath(entry), [], {
		execArgv: variant === "tsx" ? ["--import", import.meta.resolve("tsx")] : [],
		serialization: "advanced",
		stdio: ["ignore", "ignore", "inherit", "ipc"],
	});
	// The daemon keeps one spare kernel that has already loaded its modules. Time from its start command.
	if (variant === "spare") {
		await new Promise((resolve) => setTimeout(resolve, 3_000));
		start = performance.now();
	}
	await new Promise<void>((resolve, reject) => {
		child.on("message", (packet: any) => {
			if (packet.type === "ready" && !marks.ready) marks.ready = performance.now() - start;
			if (packet.type === "error") reject(new Error(packet.message));
			if (packet.type === "events" && packet.events.some((e: any) => e.type === "snapshot") && !marks.snapshot) {
				marks.snapshot = performance.now() - start;
				marks.snapshotKB = JSON.stringify(packet.events).length / 1024;
				resolve();
			}
		});
		child.on("exit", (code) => reject(new Error(`worker exited ${code}`)));
		child.send({
			type: "start",
			spec: {
				sessionId: meta.id,
				projectId: meta.projectId,
				storageDir: join(home, "durable"),
				cwd: meta.cwd,
				model: meta.model,
				thinking: meta.thinking,
				...(meta.workspace ? { trustDirectory: meta.workspace.source, pilot: { workspace: meta.workspace } } : {}),
			},
		});
		child.send({ type: "watch", watchId: "bench" });
	});
	child.removeAllListeners("exit");
	const closed = new Promise((resolve) => child.once("exit", resolve));
	child.send({ type: "shutdown" });
	await closed;
	await rm(home, { recursive: true, force: true });
	return marks;
}

const results: Record<Variant, Record<string, number>[]> = { tsx: [], native: [], spare: [] };
for (let i = 0; i < runs; i++) {
	for (const variant of ["tsx", "native", "spare"] as const) {
		const marks = await once(variant);
		results[variant].push(marks);
		console.log(
			variant.padEnd(7),
			Object.entries(marks)
				.map(([k, v]) => `${k}=${v.toFixed(0)}${k.endsWith("KB") ? "" : "ms"}`)
				.join(" "),
		);
	}
}
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
for (const [variant, marks] of Object.entries(results))
	console.log(
		`${variant}: median snapshot ${median(marks.map((r) => r.snapshot)).toFixed(0)}ms, best ${Math.min(...marks.map((r) => r.snapshot)).toFixed(0)}ms`,
	);
