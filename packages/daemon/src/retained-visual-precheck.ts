/** Host-only retained-visual-precheck. No production caller, dispatcher, reviewer or gate. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, opendir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
	SHADER_CHECK_TIMEOUT_MS,
	SHADER_CHECK_WORKER_RESOURCES,
	VISUAL_CHECK_WORKER_RESOURCES,
} from "@pilot/artifacts/visual-check";
import { VISUAL_CHECK_SAMPLING } from "@pilot/artifacts/visual-check-policy";
import type { ArtifactVisual } from "@pilot/protocol";
import { deliveryDigest } from "./mission-delivery-evidence.ts";
import type { AcquiredRetainedArtifact, RetainedVisualValidator } from "./retained-artifact.ts";

const NAME = "retained-visual-precheck";
const SNAPSHOT_BYTES = 32 * 1024 * 1024;
const SNAPSHOT_FILES = 4096;
const SNAPSHOT_ENTRIES = 8192;
const METADATA_BYTES = 64 * 1024;
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
/** Same size-plus-one bounded read pattern as stored-revision.ts. Never hydrate a growing file. */
async function snapshotBytes(path: string, limit: number): Promise<Buffer> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await file.stat();
		if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0 || before.size > limit)
			throw new Error("Unsupported visual precheck installation size");
		const bytes = Buffer.alloc(before.size + 1);
		let length = 0;
		while (length < bytes.length) {
			const { bytesRead } = await file.read(bytes, length, Math.min(64 * 1024, bytes.length - length), length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		const after = await file.stat();
		if (
			length !== before.size ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs
		)
			throw new Error("Visual precheck installation file changed");
		return bytes.subarray(0, length);
	} finally {
		await file.close();
	}
}
/** Keep executable hashing incremental and off long uninterrupted event-loop slices. */
async function executableSha256() {
	const file = await open(process.execPath, "r");
	try {
		const before = await file.stat();
		if (!before.isFile() || before.size > 512 * 1024 * 1024) throw new Error("Unsupported Node executable size");
		const hash = createHash("sha256");
		const buffer = Buffer.alloc(64 * 1024);
		let length = 0;
		for (;;) {
			const { bytesRead } = await file.read(buffer);
			if (!bytesRead) break;
			length += bytesRead;
			if (length > before.size) throw new Error("Node executable changed");
			hash.update(buffer.subarray(0, bytesRead));
		}
		const after = await file.stat();
		if (length !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
			throw new Error("Node executable changed");
		return hash.digest("hex");
	} finally {
		await file.close();
	}
}
interface SnapshotFile {
	url: string;
	label: string;
	bytes: Uint8Array;
}
interface FilePin {
	label: string;
	sha256: string;
	bytes: number;
}
interface ExecutionReceipt {
	scope: "host" | "initial" | "glsl";
	index?: number;
	receipt: {
		modules: FilePin[];
		assets: FilePin[];
		resolutions: { parent: string; specifier: string; label: string }[];
	};
}
interface Stage {
	stage: "modules" | "loading" | "initial" | "glsl" | "metal";
	state: "started" | "passed" | "failed" | "unavailable" | "joined";
	index?: number;
	at: number;
}
export interface RetainedVisualPrecheckResult {
	validator: typeof NAME;
	state: "passed" | "failed" | "partial" | "unavailable" | "cancelled" | "mismatch";
	descriptorSha256?: string;
	runId?: string;
	configuration: RetainedVisualValidator;
	executable: { sha256: string; node: string; versions: NodeJS.ProcessVersions; platform: string; arch: string };
	startedAt: number;
	settledAt: number;
	/** The checker affirmed its joins AND its outer worker exited normally. */
	joined: boolean;
	workerExited: boolean | null;
	stages: Stage[];
	execution: ExecutionReceipt[];
	sampling: typeof VISUAL_CHECK_SAMPLING;
	report?: ArtifactVisual;
	reason?: string;
}

function configuration(options: RetainedVisualValidator["options"], sampling: unknown) {
	return {
		options,
		sampling,
		initialWorkerTimeoutOnly: true,
		environment: "empty",
		shaderTimeoutMs: SHADER_CHECK_TIMEOUT_MS,
		initialResources: VISUAL_CHECK_WORKER_RESOURCES,
		shaderResources: SHADER_CHECK_WORKER_RESOURCES,
	};
}

function completeStages(result: RetainedVisualPrecheckResult): boolean {
	const has = (stage: Stage["stage"], state: Stage["state"], index?: number) =>
		result.stages.some((s) => s.stage === stage && s.state === state && s.index === index);
	if (result.stages.some((s) => s.state === "failed" || s.state === "unavailable")) return false;
	for (const stage of ["modules", "loading", "initial"] as const)
		if (!has(stage, "started") || !has(stage, "passed")) return false;
	if (!has("initial", "joined")) return false;
	for (let i = 0; i < (result.report?.check.shaders ?? 0); i++) {
		for (const stage of ["glsl", "metal"] as const)
			if (!has(stage, "started", i) || !has(stage, "passed", i)) return false;
		if (!has("glsl", "joined", i)) return false;
	}
	return true;
}

/** Reads installed code/assets, but executes NO visual or WASM. Retain this instance until execution.
 * Pins include all captured dependency files, even ones the selected visual never uses. */
export async function prepareRetainedVisualPrecheck(
	options: RetainedVisualValidator["options"],
	engine: string,
): Promise<{
	validator: RetainedVisualValidator;
	run(
		descriptor: unknown,
		reopen: (descriptor: unknown, signal?: AbortSignal) => Promise<AcquiredRetainedArtifact>,
		signal?: AbortSignal,
	): Promise<RetainedVisualPrecheckResult>;
}> {
	options = structuredClone(options);
	if (
		!Number.isSafeInteger(options.now) ||
		options.now < 0 ||
		!Number.isSafeInteger(options.timeoutMs) ||
		options.timeoutMs < 1 ||
		options.timeoutMs > 30_000 ||
		!engine ||
		engine.length > 256
	)
		throw new Error("Unsupported visual precheck configuration");
	const files: SnapshotFile[] = [];
	let size = 0;
	const add = async (path: string, label: string) => {
		if (files.length >= SNAPSHOT_FILES) throw new Error("Unsupported visual precheck installation size");
		const bytes = await snapshotBytes(
			path,
			Math.min(SNAPSHOT_BYTES - size, label.endsWith("/package.json") ? METADATA_BYTES : SNAPSHOT_BYTES),
		);
		size += bytes.length;
		files.push({ url: pathToFileURL(await realpath(path)).href, label, bytes });
		return bytes;
	};
	let entries = 0;
	async function* walk(path: string, recursive: boolean, depth = 0): AsyncGenerator<string> {
		if (depth > 64) throw new Error("Unsupported visual precheck directory depth");
		// One buffered entry, plus one sentinel read when the shared budget is exhausted.
		for await (const entry of await opendir(path, { bufferSize: 1 })) {
			if (++entries > SNAPSHOT_ENTRIES) throw new Error("Unsupported visual precheck directory entry count");
			const child = join(path, entry.name);
			if (entry.isFile()) yield child;
			else if (recursive && entry.isDirectory()) yield* walk(child, true, depth + 1);
		}
	}
	const root = fileURLToPath(new URL("./", import.meta.url));
	for (const name of ["retained-visual-loader.mjs", "retained-visual-worker.ts"]) await add(join(root, name), name);
	const require = createRequire(import.meta.url);
	const checker = require.resolve("@pilot/artifacts/visual-check");
	const artifactRoot = dirname(dirname(checker));
	for await (const path of walk(join(artifactRoot, "visual"), false)) {
		const name = relative(join(artifactRoot, "visual"), path);
		if ((name.endsWith(".ts") && !name.endsWith(".test.ts")) || name === "runtime.js")
			await add(path, `visual/${name}`);
	}
	for (const name of ["shader.ts", "shader-check-worker.ts"]) await add(join(artifactRoot, name), name);
	const artifactRequire = createRequire(pathToFileURL(checker));
	for (const dependency of ["quickjs-wasi", "typebox", "naga-wasm", "glslang-wasm-validator"]) {
		const dir = await realpath(join(artifactRoot, "..", "node_modules", dependency));
		const metadata = await add(join(dir, "package.json"), `${dependency}/package.json`);
		if (JSON.parse(metadata.toString("utf8")).name !== dependency)
			throw new Error("Unsupported visual dependency layout");
		for await (const path of walk(dir, true)) {
			if (path !== join(dir, "package.json") && /\.(?:js|mjs|cjs|json|wasm)$/.test(path)) {
				await add(path, `${dependency}/${relative(dir, path)}`);
			}
		}
	}
	files.sort((a, b) => a.label.localeCompare(b.label, "en"));
	const executable = {
		sha256: await executableSha256(),
		node: process.version,
		versions: structuredClone(process.versions),
		platform: process.platform,
		arch: process.arch,
	};
	const assets = files.filter((f) => f.label.endsWith(".wasm") || f.label === "visual/runtime.js");
	const pins = (selected: SnapshotFile[]) =>
		selected.map((f) => ({ label: f.label, sha256: sha(f.bytes), bytes: f.bytes.length }));
	const validator: RetainedVisualValidator = {
		buildSha256: deliveryDigest(pins(files.filter((f) => !assets.includes(f)))),
		runtimeSha256: deliveryDigest({ executable, assets: pins(assets) }),
		configSha256: deliveryDigest(configuration(options, VISUAL_CHECK_SAMPLING)),
		api: 1,
		engine,
		options,
	};
	const frozenValidator = structuredClone(validator);
	const loader = files.find((f) => f.label === "retained-visual-loader.mjs")!;
	const preload = `data:text/javascript;base64,${Buffer.from(loader.bytes).toString("base64")}`;
	const snapshot = { files };
	const expectedFiles = new Map(pins(files).map((p) => [p.label, deliveryDigest(p)]));
	const receiptValid = (execution: ExecutionReceipt[]) => {
		try {
			return execution.every(
				({ receipt }) =>
					receipt.modules.length > 0 &&
					[...receipt.modules, ...receipt.assets].every((p) => deliveryDigest(p) === expectedFiles.get(p.label)) &&
					receipt.resolutions.every(
						(r) => expectedFiles.has(r.label) && (r.parent === "bootstrap" || expectedFiles.has(r.parent)),
					),
			);
		} catch {
			return false;
		}
	};
	return {
		validator: structuredClone(validator),
		async run(descriptor, reopen, signal) {
			const result: RetainedVisualPrecheckResult = {
				validator: NAME,
				state: "unavailable",
				configuration: structuredClone(frozenValidator),
				executable: structuredClone(executable),
				startedAt: Date.now(),
				settledAt: 0,
				joined: true,
				workerExited: null,
				stages: [],
				execution: [],
				sampling: structuredClone(VISUAL_CHECK_SAMPLING),
			};
			let worker: Worker | undefined;
			let abort: (() => void) | undefined;
			try {
				signal?.throwIfAborted();
				const executableBefore = await executableSha256();
				const input = await reopen(descriptor, signal);
				signal?.throwIfAborted();
				result.descriptorSha256 = input.descriptorSha256;
				result.runId = input.descriptor.header.runId;
				if (
					deliveryDigest(input.descriptor) !== input.descriptorSha256 ||
					deliveryDigest(input.descriptor.validator) !== deliveryDigest(frozenValidator) ||
					sha(input.containerBytes) !== input.descriptor.container.sha256 ||
					sha(input.validationInput.source) !== input.descriptor.derived.source.sha256 ||
					sha(input.validationInput.dataJSON) !== input.descriptor.derived.dataJSON.sha256 ||
					input.validationInput.id !== input.descriptor.derived.id ||
					executableBefore !== executable.sha256
				) {
					result.state = "mismatch";
					throw new Error("Visual input, executable or configuration mismatch");
				}
				signal?.throwIfAborted();
				// Clean execArgv: no inherited test runner, custom loader, watch mode or user preload.
				result.stages.push({ stage: "modules", state: "started", at: Date.now() });
				worker = new Worker(`import(${JSON.stringify(preload)})`, {
					eval: true,
					execArgv: ["--import", preload],
					env: {},
					workerData: {
						snapshot,
						retainedVisualEntry: files.find((f) => f.label === "retained-visual-worker.ts")!.url,
						input: {
							source: input.validationInput.source,
							data: input.validationInput.dataJSON,
							id: input.validationInput.id,
						},
						options,
						expectedConfiguration: configuration(options, VISUAL_CHECK_SAMPLING),
						wasm: pathToFileURL(artifactRequire.resolve("quickjs-wasi/quickjs.wasm")).href,
						runtime: pathToFileURL(join(artifactRoot, "visual/runtime.js")).href,
					},
					stdout: true,
					stderr: true,
				});
				result.joined = false;
				result.workerExited = false;
				abort = () => worker!.postMessage({ abort: true });
				signal?.addEventListener("abort", abort, { once: true });
				if (signal?.aborted) abort();
				let completed = false;
				let sampled = false;
				let checkerSettled = false;
				let shaderCount = 0;
				let configured = false;
				await new Promise<void>((resolve) => {
					worker!.on("message", (message) => {
						if (message.type === "settled") checkerSettled = true;
						if (message.type === "provenance")
							result.execution.push({ scope: message.scope, index: message.index, receipt: message.receipt });
						if (message.type === "stage")
							result.stages.push({
								stage: message.stage,
								state: message.state,
								index: message.index,
								at: message.at,
							});
						if (message.type === "configuration") {
							configured = deliveryDigest(message.configuration) === validator.configSha256;
							result.stages.push({
								stage: "modules",
								state: configured ? "passed" : "unavailable",
								at: Date.now(),
							});
						}
						if (message.type === "sample" && message.result.ok) {
							sampled = true;
							shaderCount = message.result.shaders.length;
							const r = message.result.report;
							if (
								r.interactions >= VISUAL_CHECK_SAMPLING.limits.interactions ||
								r.draws >= VISUAL_CHECK_SAMPLING.limits.checkedDraws
							)
								result.state = "partial";
						}
						if (message.type === "result") {
							completed = true;
							result.report = message.result;
							if (result.state !== "partial") result.state = "passed";
						}
						if (message.type === "error") {
							result.state = message.state;
							result.reason = message.message;
						}
					});
					worker!.once("error", (error) => {
						result.state = "unavailable";
						result.reason =
							error instanceof Error ? error.message.slice(0, 4096) : "Validation worker unavailable";
					});
					worker!.once("exit", (code) => {
						result.workerExited = true;
						const allStartedJoined = result.stages
							.filter((s) => s.state === "started" && ["loading", "initial", "glsl"].includes(s.stage))
							.every((start) =>
								result.stages.some(
									(s) => s.stage === start.stage && s.index === start.index && s.state === "joined",
								),
							);
						result.joined = checkerSettled && code === 0 && allStartedJoined;
						const receipts = result.execution;
						const haveReceipts =
							receipts.some((e) => e.scope === "host") &&
							receipts.some((e) => e.scope === "initial") &&
							Array.from({ length: shaderCount }, (_, i) => i).every((i) =>
								receipts.some((e) => e.scope === "glsl" && e.index === i),
							);
						if (
							!result.joined ||
							!completed ||
							!configured ||
							!sampled ||
							!completeStages(result) ||
							!haveReceipts ||
							!receiptValid(receipts) ||
							shaderCount !== (result.report?.check.shaders ?? 0)
						) {
							if (result.state === "passed" || result.state === "partial") {
								result.state = "unavailable";
								result.report = undefined;
								result.reason = "Visual execution configuration, stages, receipts or join is incomplete";
							}
						}
						resolve();
					});
				});
				signal?.throwIfAborted();
				if ((await executableSha256()) !== executable.sha256) {
					result.state = "mismatch";
					result.report = undefined;
					result.reason = "Node executable changed during validation";
				}
				const current = await reopen(input.descriptor, signal);
				signal?.throwIfAborted();
				if (
					current.descriptorSha256 !== input.descriptorSha256 ||
					(result.report && (result.report.engine !== engine || result.report.api !== validator.api))
				) {
					result.state = "mismatch";
					result.report = undefined;
					result.reason = "Visual engine/API or current retained descriptor changed";
				}
			} catch (error) {
				result.report = undefined;
				if (signal?.aborted) result.state = "cancelled";
				else if (result.state !== "mismatch") result.state = "unavailable";
				result.reason = error instanceof Error ? error.message.slice(0, 4096) : "Visual precheck unavailable";
			} finally {
				if (abort) signal?.removeEventListener("abort", abort);
				// No race-only cancellation: owned worker exit and nested termination precede return.
				if (worker && !result.workerExited) {
					await worker.terminate();
					result.workerExited = true;
				}
				result.settledAt = Date.now();
			}
			return result;
		},
	};
}
