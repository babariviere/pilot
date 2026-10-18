/** Offline status-builder comparison. No sessions, workers, providers, network or user state. */
import { execFileSync } from "node:child_process";
import type { Mission, Project, SessionSummary } from "@pilot/protocol";
import { buildControlDashboard } from "../../packages/daemon/src/control-dashboard.ts";

const base = process.argv[2] ?? "4d67c6e1";
const source = execFileSync("/usr/bin/git", ["show", `${base}:packages/daemon/src/control-pilot.ts`], {
	encoding: "utf8",
});
const start = source.indexOf("\tprivate status("),
	end = source.indexOf("\tprivate async read(", start);
if (start < 0 || end < 0) throw new Error("Baseline must contain the original private status builder");
const method = source.slice(start, end),
	body = method.slice(method.indexOf("{") + 1, method.lastIndexOf("}"));
// Execute only trusted repository source, with its two local pure helpers supplied explicitly.
const baseline = new Function("args", "string", "short", body);
const short = (text: string | undefined, n = 160) => text?.replace(/[\r\n]/g, " ").slice(0, n);
const count = Number(process.argv[3] ?? 10000);
if (!Number.isInteger(count) || count < 1 || count > 100000) throw new Error("count must be 1..100000");
const chats: SessionSummary[] = Array.from({ length: count }, (_, i) => ({
	id: `chat-${i}`,
	title: `Chat ${i} ${"title ".repeat(100)}`,
	cwd: "/unused",
	projectId: `p${i % 10}`,
	missionId: `m${i % 20}`,
	state: "working",
	working: true,
	model: "test/model",
	createdAt: 1,
	updatedAt: 2,
	pullRequests: Array.from({ length: 4 }, (_, j) => ({
		number: j + 1,
		url: `https://github.com/example/repo/pull/${i * 4 + j + 1}`,
		title: `PR ${j}`,
		state: "open",
		checkedAt: 1,
	})),
}));
const options = {
	sessions: { list: () => chats },
	projects: () => Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}` })) as Project[],
	missions: () =>
		Array.from({ length: 20 }, (_, i) => ({
			id: `m${i}`,
			projectId: `p${i % 10}`,
			title: `Mission ${i}`,
			status: "active",
			tasksDone: 10,
			tasksTotal: 20,
		})) as Mission[],
	linear: () => [],
};
function sample(run: () => unknown) {
	const cpu = process.cpuUsage(),
		start = performance.now();
	let bytes = 0;
	for (let i = 0; i < 20; i++) {
		// Simulate repeated state changes while work streams, not repeated serialization of a frozen output.
		chats[i % chats.length]!.updatedAt++;
		bytes = Buffer.byteLength(JSON.stringify(run()));
	}
	const elapsed = performance.now() - start,
		used = process.cpuUsage(cpu);
	return { wallMs: elapsed / 20, cpuMs: (used.user + used.system) / 20000, bytes };
}
const before = () => baseline.call({ options }, {}, (args: Record<string, unknown>, key: string) => args[key], short);
const after = () => buildControlDashboard(options);
const samples = { before: [] as ReturnType<typeof sample>[], after: [] as ReturnType<typeof sample>[] };
for (let i = 0; i < 6; i++) {
	for (const key of (i % 2 ? ["after", "before"] : ["before", "after"]) as Array<keyof typeof samples>) {
		const value = sample(key === "before" ? before : after);
		if (i) samples[key].push(value);
	}
}
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
for (const [key, values] of Object.entries(samples))
	console.log(
		JSON.stringify({
			key,
			chats: count,
			wallMs: median(values.map((v) => v.wallMs)),
			cpuMs: median(values.map((v) => v.cpuMs)),
			bytes: values.at(-1)!.bytes,
		}),
	);
