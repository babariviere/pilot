// Runs only in owned validation workers. Every non-builtin module and runtime asset comes from
// the host's byte snapshot, not a later disk reread or an already populated module/WASM cache.

import { createHash } from "node:crypto";
import fs from "node:fs";
import promises from "node:fs/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getEnvironmentData, setEnvironmentData, workerData } from "node:worker_threads";

const key = "retained-visual-precheck.snapshot.v1";
const snapshot = getEnvironmentData(key) ?? workerData.snapshot;
setEnvironmentData(key, snapshot);
const realpath = fs.realpathSync;
const files = new Map(snapshot.files.map((file) => [file.url, file]));
const modules = new Map();
const assets = new Map();
const resolutions = new Map();
const formats = new Map();
function pin(file) {
	return {
		label: file.label,
		sha256: createHash("sha256").update(file.bytes).digest("hex"),
		bytes: file.bytes.length,
	};
}
Reflect.set(globalThis, "__retainedVisualProvenance", () => ({
	modules: [...modules.values()],
	assets: [...assets.values()],
	resolutions: [...resolutions.values()],
}));
function selected(path) {
	const url = pathToFileURL(realpath(path instanceof URL ? fileURLToPath(path) : path)).href;
	const file = files.get(url);
	if (!file) throw new Error("Unsupported precheck dependency outside frozen snapshot");
	return file;
}
function bytes(path, options) {
	const file = selected(path);
	assets.set(file.label, pin(file));
	const data = Buffer.from(file.bytes);
	const encoding = typeof options === "string" ? options : options?.encoding;
	return encoding ? data.toString(encoding) : data;
}
registerHooks({
	resolve(specifier, context, next) {
		const result = next(specifier, context);
		if (result.url.startsWith("file:")) {
			const file = selected(new URL(result.url));
			const parent = context.parentURL?.startsWith("file:")
				? selected(new URL(context.parentURL)).label
				: "bootstrap";
			resolutions.set(`${parent}\n${specifier}`, { parent, specifier, label: file.label });
			formats.set(result.url, result.format);
		}
		return result;
	},
	load(url, context, next) {
		if (url.startsWith("node:") || !url.startsWith("file:")) {
			if (!url.startsWith("node:")) throw new Error("Unsupported precheck module protocol");
			return next(url, context);
		}
		const file = selected(new URL(url));
		const format = context.format ?? formats.get(url);
		if (!["module", "module-typescript", "json"].includes(format))
			throw new Error("Unsupported precheck module format");
		modules.set(file.label, pin(file));
		return { format, source: Buffer.from(file.bytes), shortCircuit: true };
	},
});
fs.readFileSync = bytes;
promises.readFile = async (path, options) => bytes(path, options);
syncBuiltinESMExports();

// Nested checker workers only install this same byte loader through --import.
if (workerData?.retainedVisualEntry) await import(workerData.retainedVisualEntry);
