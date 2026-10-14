/** Synthetic large-tree inspection with streaming timer activity, no repositories or accounts modified.
 * node scripts/bench/workspace-cleanup.ts [baseline-revision]
 * Uses real filesystem traversal, but replays Git/jj listings to isolate inspection CPU and event-loop cost.
 */
// biome-ignore-all lint/complexity/useLiteralKeys: Measure the private inspection seam, not repository commands.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { SharedWorkspaceStore } from "../../packages/daemon/src/shared-workspaces.ts";
import type { Runner } from "../../packages/daemon/src/workspaces.ts";

const root = await mkdtemp(join(tmpdir(), "pilot-cleanup-bench-"));
try {
	const tree = join(root, "tree");
	const files: string[] = [];
	const outputs: string[] = [];
	for (let directory = 0; directory < 600; directory++) {
		const path = `packages/pkg-${directory}`;
		await mkdir(join(tree, path, "node_modules"), { recursive: true });
		outputs.push(`${path}/node_modules/`);
		for (let file = 0; file < 50; file++) {
			const name = `${path}/source-${file}.ts`;
			await writeFile(join(tree, name), "export {};\n");
			files.push(name);
		}
	}
	const listing = files.map((path) => `${path}\0file\0`).join("");
	const runner: Runner = async (file, args) => {
		if (file === "jj" && args.includes("sparse")) return ".";
		if (file === "jj" && args.includes("list")) return listing;
		if (file === "git" && args.includes("--stage")) return "";
		if (file === "git" && args.includes("--ignored")) return outputs.join("\0");
		if (file === "git" && args.includes("check-ignore")) return args.at(-1)!;
		throw new Error(`Unexpected benchmark command: ${file} ${args.join(" ")}`);
	};
	const variants: [string, typeof SharedWorkspaceStore][] = [];
	const baseline = process.argv[2];
	if (baseline) {
		const { stdout } = await promisify(execFile)(
			"jj",
			["file", "show", "-r", baseline, "packages/daemon/src/shared-workspaces.ts"],
			{ maxBuffer: 1024 * 1024 },
		);
		const directory = dirname(
			fileURLToPath(new URL("../../packages/daemon/src/shared-workspaces.ts", import.meta.url)),
		);
		const source = stdout.replace(
			/from "(\.\/[^"]+)"/g,
			(_, path: string) => `from ${JSON.stringify(pathToFileURL(resolve(directory, path)).href)}`,
		);
		const module = join(root, "baseline.ts");
		await writeFile(module, source);
		variants.push([baseline, (await import(pathToFileURL(module).href)).SharedWorkspaceStore]);
	}
	variants.push(["current", SharedWorkspaceStore]);
	console.log(`${files.length} tracked files, ${outputs.length} ignored dependency directories; 5ms streaming timer`);
	for (let sample = 0; sample < 3; sample++) {
		// Alternate order to reduce filesystem-cache and host-load bias.
		for (const [name, Store] of sample % 2 ? [...variants].reverse() : variants) {
			const monitor = monitorEventLoopDelay({ resolution: 5 });
			monitor.enable();
			let packets = 0;
			const streaming = setInterval(() => {
				JSON.stringify({ type: "text_delta", text: "x".repeat(4096), sequence: packets++ });
			}, 5);
			try {
				await delay(20);
				const start = performance.now();
				await new Store(root, runner)["inspect"](tree);
				const duration = performance.now() - start;
				await delay(10);
				console.log(
					`${name} #${sample + 1}: ${duration.toFixed(1)}ms, max loop delay ${(monitor.max / 1e6).toFixed(1)}ms, ${packets} packets`,
				);
			} finally {
				clearInterval(streaming);
				monitor.disable();
			}
		}
	}
} finally {
	await rm(root, { recursive: true, force: true });
}
