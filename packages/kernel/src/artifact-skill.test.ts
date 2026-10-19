import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { artifactLibraries } from "@pilot/artifacts";
import { ARTIFACT_SKILL_FILES, ARTIFACT_SKILL_PATH, ARTIFACT_SKILL_REFERENCES } from "./artifact-skill.ts";

test("bundled artifact skill is valid and retains detailed authoring guidance outside the tool catalog", async () => {
	const loaded = loadSkillsFromDir({ dir: dirname(ARTIFACT_SKILL_PATH), source: "pilot" });
	assert.deepEqual(loaded.diagnostics, []);
	assert.equal(loaded.skills.length, 1);
	assert.equal(loaded.skills[0]!.name, "pilot-artifacts");
	assert.equal(loaded.skills[0]!.filePath, ARTIFACT_SKILL_PATH);
	assert.match(loaded.skills[0]!.description, /HTML.*React.*image.*SwiftUI/);
	assert.match(loaded.skills[0]!.description, /Use before creating, updating or previewing an artifact/);
	assert.equal(loaded.skills[0]!.disableModelInvocation, false);
	const root = await readFile(ARTIFACT_SKILL_PATH, "utf8");
	// The root routes to every per-kind reference, and every route exists.
	for (const reference of ARTIFACT_SKILL_REFERENCES) {
		const relative = `references/${reference.split("/").at(-1)}`;
		assert.ok(root.includes(`](${relative})`), `SKILL.md does not route to ${relative}`);
	}
	// Rules that apply to every artifact stay in the root, not behind a route.
	for (const guidance of [
		"Ask image sources must be inline base64",
		"Do not install or request a browser",
		"expectedRevision",
	])
		assert.ok(root.includes(guidance), `SKILL.md is missing ${guidance}`);
	const source = (await Promise.all(ARTIFACT_SKILL_FILES.map((path) => readFile(path, "utf8")))).join("\n");
	for (const guidance of [
		"512 KiB UTF-8",
		"16 MiB",
		"expectedRevision",
		"default-export",
		"echarts.init",
		"ui.mermaid",
		"motion.animate",
		"d3.select",
		"THREE.Scene",
		"arbitrary npm imports",
		"Tailwind is not available",
		"native bridge",
		"<style>",
		"ArtifactView",
		"Command Line Tools",
		"static screenshot",
		"@StateObject",
		"workspace/credential access",
		"ImageRenderer",
		"Do not install or request a browser",
		"mainImage",
		"omit `#version`",
		"iMouse",
		"Choose a native visual first",
		"String(visual)",
		"in the same script",
		"interface UI",
		"onChange",
	])
		assert.ok(source.includes(guidance), `missing ${guidance}`);
	// Mermaid diagrams go to visuals (ui.mermaid); the library keeps working in HTML but is no longer advertised.
	for (const name of Object.keys(artifactLibraries).filter((name) => name !== "mermaid"))
		assert.ok(source.includes(`\`${name}\``), name);
	assert.doesNotMatch(source, /libraries: \["mermaid"\]|mermaid\.initialize/);
	for (const name of ["background", "foreground", "muted", "muted-foreground", "border", "primary", "radius"])
		assert.ok(source.includes(`--pilot-${name}`), name);
	assert.match(source, /Ask image sources must be inline base64/);
	assert.match(source, /Ask does not authorize shell execution or repository mutations/);
});

test("bundled skill location follows a relocated kernel package, not the session cwd or original checkout", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pilot-artifact-skill-runtime-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const relocatedModule = join(root, "packages", "kernel", "src", "artifact-skill.ts");
	const relocatedSkill = join(root, "packages", "kernel", "skills", "pilot-artifacts", "SKILL.md");
	await mkdir(dirname(relocatedModule), { recursive: true });
	await mkdir(dirname(relocatedSkill), { recursive: true });
	await copyFile(fileURLToPath(new URL("./artifact-skill.ts", import.meta.url)), relocatedModule);
	await copyFile(ARTIFACT_SKILL_PATH, relocatedSkill);
	const relocated = await import(pathToFileURL(relocatedModule).href);
	assert.equal(relocated.ARTIFACT_SKILL_PATH, relocatedSkill);
	const loaded = loadSkillsFromDir({ dir: dirname(relocated.ARTIFACT_SKILL_PATH), source: "pilot" });
	assert.deepEqual(loaded.diagnostics, []);
	assert.equal(loaded.skills[0]?.filePath, relocatedSkill);
});
