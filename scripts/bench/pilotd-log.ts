/**
 * Summarize pilotd event-loop stalls from its log: size buckets, stalled time per day, what was slow or in flight,
 * and (for logs with main-thread CPU) whether stalls were computing or waiting.
 *   node scripts/bench/pilotd-log.ts [~/Library/Logs/Pilot/pilotd.log] [--since 2026-10-15]
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { since: { type: "string" } } });
const file = positionals[0] ?? join(homedir(), "Library/Logs/Pilot/pilotd.log");
const since = values.since ?? "";
const ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

interface Stall {
	at: string;
	ms: number;
	cpuMs?: number;
	context: string[];
}

const stalls: Stall[] = [];
const restarts: string[] = [];
for (const line of (await readFile(file, "utf8")).split("\n")) {
	const at = line.match(/^\[([^\]]+)\]/)?.[1] ?? "";
	if (at < since) continue;
	if (line.includes("pilotd listening")) restarts.push(at);
	const match = line.match(/event loop delayed for (\d+)ms \(([^)]*)\)(.*)$/);
	if (!match) continue;
	const cpu = match[2]!.match(/cpu (\d+)ms/);
	stalls.push({
		at,
		ms: Number(match[1]),
		...(cpu ? { cpuMs: Number(cpu[1]) } : {}),
		context: match[3]!.split("; ").filter(Boolean),
	});
}

const SLEEP_MS = 60_000;
const buckets = new Map([
	["1-2s", 0],
	["2-5s", 0],
	["5-15s", 0],
	["15-60s", 0],
	["60s+ (likely sleep)", 0],
]);
for (const { ms } of stalls) {
	const key =
		ms < 2e3 ? "1-2s" : ms < 5e3 ? "2-5s" : ms < 15e3 ? "5-15s" : ms < SLEEP_MS ? "15-60s" : "60s+ (likely sleep)";
	buckets.set(key, buckets.get(key)! + 1);
}
console.log(`${stalls.length} stalls, ${restarts.length} daemon starts${since ? ` since ${since}` : ""}`);
console.log(`size: ${[...buckets].map(([key, count]) => `${key} ${count}`).join(", ")}`);

const days = new Map<string, { count: number; ms: number }>();
for (const stall of stalls) {
	if (stall.ms >= SLEEP_MS) continue;
	const day = days.get(stall.at.slice(0, 10)) ?? { count: 0, ms: 0 };
	day.count++;
	day.ms += stall.ms;
	days.set(stall.at.slice(0, 10), day);
}
console.log("stalled time per day, excluding likely sleep:");
for (const [day, { count, ms }] of days) console.log(`  ${day}  ${count} stalls, ${Math.round(ms / 1000)}s`);

const measured = stalls.filter((stall) => stall.cpuMs !== undefined && stall.ms < SLEEP_MS);
if (measured.length) {
	const busy = measured.filter((stall) => stall.cpuMs! >= stall.ms / 2);
	console.log(
		`main-thread CPU: ${busy.length} computing, ${measured.length - busy.length} waiting (disk, CPU or sleep) of ${measured.length}`,
	);
}

const labels = new Map<string, { count: number; ms: number[] }>();
for (const stall of stalls)
	for (const entry of stall.context) {
		const label = entry.replace(ID, ":id").replace(/ \([^)]*\)$/, "");
		const value = labels.get(label) ?? { count: 0, ms: [] };
		value.count++;
		const ms = entry.match(/\((\d+)ms/);
		if (ms) value.ms.push(Number(ms[1]));
		labels.set(label, value);
	}
console.log("context (count, p50/max ms):");
for (const [label, { count, ms }] of [...labels].sort((a, b) => b[1].count - a[1].count).slice(0, 20)) {
	ms.sort((a, b) => a - b);
	console.log(`  ${String(count).padStart(5)}  ${label}  ${ms[ms.length >> 1] ?? "-"}/${ms.at(-1) ?? "-"}`);
}
console.log("longest stalls under a minute:");
for (const stall of stalls
	.filter((stall) => stall.ms < SLEEP_MS)
	.sort((a, b) => b.ms - a.ms)
	.slice(0, 8))
	console.log(
		`  ${stall.at}  ${stall.ms}ms${stall.cpuMs !== undefined ? ` (cpu ${stall.cpuMs}ms)` : ""}  ${stall.context.slice(0, 2).join(" | ").replace(ID, ":id").slice(0, 140)}`,
	);
