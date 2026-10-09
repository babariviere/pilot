/** Prebuild offline artifact libraries for release bundles, so pilotd never runs esbuild on first use. */
import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactLibrary } from "@pilot/protocol";
import { artifactLibraries, buildLibrary, libraryBuildKey, PREBUILT_LIBRARY_DIRECTORY } from "../src/render.ts";

const directory = PREBUILT_LIBRARY_DIRECTORY;
await mkdir(directory, { recursive: true });
const manifest: Record<string, { key: string; sha256: string }> = {};
for (const name of Object.keys(artifactLibraries) as ArtifactLibrary[]) {
	const source = await buildLibrary(name);
	await writeFile(join(directory, `${name}.js`), source);
	manifest[name] = { key: libraryBuildKey(name), sha256: createHash("sha256").update(source).digest("hex") };
	console.log(`${name}: ${Math.round(Buffer.byteLength(source) / 1024)} KiB`);
}
// The manifest is written last: an interrupted build is ignored rather than partially used.
await writeFile(join(directory, "manifest.json.tmp"), `${JSON.stringify(manifest, null, "\t")}\n`);
await rename(join(directory, "manifest.json.tmp"), join(directory, "manifest.json"));
