// The app's visual engine (QuickJS-NG C, vendored by vendor-quickjs.sh) must be the release the kernel's
// quickjs-wasi embeds for the publish-time pre-check, or a visual could pass the pre-check and fail in the app.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const scripts = join(dirname(fileURLToPath(import.meta.url)), "..");
const repository = join(scripts, "../../..");

/** The directory of package name as Node resolves it from directory, or undefined. */
function findPackage(name, directory) {
	for (let current = directory; ; current = dirname(current)) {
		const candidate = join(current, "node_modules", name);
		if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
		if (dirname(current) === current) return undefined;
	}
}

/** quickjs-wasi as the kernel loads it: its own dependency, or the one the Pi SDK's codemode package uses. */
function quickJSDirectory() {
	let directory = join(repository, "packages/kernel");
	for (const step of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-codemode"]) {
		const found = findPackage("quickjs-wasi", directory);
		if (found) return found;
		directory = findPackage(step, directory);
		assert.ok(directory, `${step} is not installed. Run pnpm install.`);
	}
	const found = findPackage("quickjs-wasi", directory);
	assert.ok(found, "quickjs-wasi is not installed. Run pnpm install.");
	return found;
}

test("the vendored QuickJS-NG release matches the kernel's quickjs-wasi engine", async () => {
	const pinned = execFileSync(join(scripts, "vendor-quickjs.sh"), ["--version"], { encoding: "utf8" }).trim();
	const directory = quickJSDirectory();
	const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	const { QuickJS } = await import(pathToFileURL(join(directory, manifest.exports["."].default)).href);
	const wasm = readFileSync(join(directory, manifest.exports["./quickjs.wasm"]));
	const vm = await QuickJS.create({ wasm });
	try {
		assert.equal(
			pinned,
			vm.versions.quickjs,
			"Bump apps/macos/scripts/vendor-quickjs.sh (version and sha256) to the QuickJS-NG release quickjs-wasi embeds",
		);
	} finally {
		vm.dispose?.();
	}
});
