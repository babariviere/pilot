/**
 * End-to-end reopen benchmark through a real pilotd: copy one session's metadata and durable storage
 * into a temporary PILOT_HOME, then time WebSocket subscribe -> first snapshot for a cold kernel and
 * for a kernel reopened after inactivity parking (served by the warm spare).
 *   node scripts/bench/daemon-reopen.ts <session-dir>
 */
import { type ChildProcess, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const [sessionDir] = process.argv.slice(2);
if (!sessionDir) throw new Error("usage: daemon-reopen.ts <session-dir>");
const meta = JSON.parse(await readFile(join(sessionDir, "meta.json"), "utf8"));
const home = await mkdtemp(join(tmpdir(), "pilot-daemon-bench-"));
const port = 4400 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
let daemon: ChildProcess | undefined;

async function until<T>(check: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await check().catch(() => undefined);
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

async function state(): Promise<string> {
	const response = await fetch(`${base}/api/sessions/${meta.id}`);
	return ((await response.json()) as { state: string }).state;
}

async function reopen(): Promise<number> {
	const socket = new WebSocket(`${base}/api/ws`);
	await new Promise((resolve, reject) => socket.once("open", resolve).once("error", reject));
	const start = performance.now();
	const done = new Promise<number>((resolve) =>
		socket.on("message", (data) => {
			const update = JSON.parse(String(data));
			if (update.type === "events" && update.events.some((event: { type: string }) => event.type === "snapshot"))
				resolve(performance.now() - start);
		}),
	);
	socket.send(JSON.stringify({ type: "subscribe", sessionId: meta.id }));
	const elapsed = await done;
	socket.close();
	return elapsed;
}

try {
	const target = join(home, "sessions", meta.id);
	await mkdir(target, { recursive: true });
	// Never point the copy at live storage, and never resume interrupted work.
	await cp(join(sessionDir, "durable"), join(target, "durable"), { recursive: true });
	const { pending: _pending, working: _working, initializing: _initializing, ...rest } = meta;
	await writeFile(join(target, "meta.json"), JSON.stringify({ ...rest, archivedAt: undefined }));
	daemon = spawn(process.execPath, ["packages/daemon/src/main.ts"], {
		env: { ...process.env, PILOT_HOME: home, PILOT_PORT: String(port), PILOT_IDLE_PARK_MS: "1000" },
		stdio: ["ignore", "ignore", "inherit"],
	});
	await until(async () => ((await fetch(`${base}/api/sessions`)).ok ? true : undefined));
	// Let the daemon settle and fork its spare, as it would long before a user opens a chat.
	await new Promise((resolve) => setTimeout(resolve, 5_000));
	const runs: number[] = [];
	for (let i = 0; i < 5; i++) {
		runs.push(await reopen());
		await until(async () => ((await state()) === "parked" ? true : undefined));
		await new Promise((resolve) => setTimeout(resolve, 5_500));
	}
	console.log(`reopen after parking (warm spare): ${runs.map((ms) => `${ms.toFixed(0)}ms`).join(" ")}`);
} finally {
	daemon?.kill("SIGTERM");
	await new Promise((resolve) => setTimeout(resolve, 1_000));
	await rm(home, { recursive: true, force: true });
}
