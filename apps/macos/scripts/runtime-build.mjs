/** Metadata for an immutable production runtime, sealed by the enclosing app signature. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function writeRuntimeBuild(root, source) {
	if (!/^[a-f0-9]{40}$/.test(source)) throw new Error("A full immutable source commit is required");
	if (!/^24\./.test(process.versions.node)) throw new Error("Bundled Node24 is required");
	const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
	if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("A stable package version is required");
	writeFileSync(
		resolve(root, "runtime-build.json"),
		JSON.stringify({
			schema: 1,
			source,
			version,
			protocol: 1,
			platform: process.platform,
			arch: process.arch,
			node: process.versions.node,
		}),
		{ mode: 0o600, flag: "wx" },
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	writeRuntimeBuild(process.argv[2], process.argv[3]);
}
