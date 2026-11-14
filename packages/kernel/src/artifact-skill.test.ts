import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import {
	ARTIFACT_NSH_FILES,
	ARTIFACT_SKILL_FILES,
	ARTIFACT_SKILL_PATH,
	ARTIFACT_SKILL_REFERENCES,
} from "./artifact-skill.ts";

test("bundled artifact skill is valid and keeps detailed writing guidance outside the tool catalog", async () => {
	const loaded = loadSkillsFromDir({ dir: dirname(ARTIFACT_SKILL_PATH), source: "pilot" });
	assert.deepEqual(loaded.diagnostics, []);
	assert.equal(loaded.skills.length, 1);
	assert.equal(loaded.skills[0]!.name, "pilot-artifacts");
	assert.equal(loaded.skills[0]!.filePath, ARTIFACT_SKILL_PATH);
	assert.match(loaded.skills[0]!.description, /NSH and image artifacts/);
	assert.match(loaded.skills[0]!.description, /Use before creating or updating/);
	assert.equal(loaded.skills[0]!.disableModelInvocation, false);
	const root = await readFile(ARTIFACT_SKILL_PATH, "utf8");
	// The root routes to every per-kind reference, and every reference file is listed.
	for (const reference of ARTIFACT_SKILL_REFERENCES) {
		const relative = `references/${reference.split("/").at(-1)}`;
		assert.ok(root.includes(`](${relative})`), `SKILL.md does not route to ${relative}`);
	}
	assert.deepEqual(
		(await readdir(join(dirname(ARTIFACT_SKILL_PATH), "references"))).sort(),
		ARTIFACT_SKILL_REFERENCES.map((path) => path.split("/").at(-1)).sort(),
	);
	const source = (await Promise.all(ARTIFACT_SKILL_FILES.map((path) => readFile(path, "utf8")))).join("\n");
	for (const guidance of [
		"Ask image sources must be inline base64",
		"Ask does not authorize shell execution",
		"512 KiB UTF-8",
		"16 MiB",
		"expectedRevision",
		'kind: "nsh"',
		'kind: "image"',
		"sourcePath",
		"FlowDiagram",
		"workspace/credential access",
		"arbitrary npm imports",
		"read-only",
		"no artifact screenshot preview host",
	])
		assert.ok(source.includes(guidance), `missing ${guidance}`);
	assert.doesNotMatch(
		source,
		/kind: "(?:html|react|swiftui|visual|shader)"|String\(visual\)|ui\.mermaid|mainImage|echarts\.init|ArtifactView|mermaid\.initialize|motion\.animate|THREE\.Scene/,
	);
});

test("NSH examples and trusted helpers are all readable and import only what artifacts get", async () => {
	const nsh = join(dirname(ARTIFACT_SKILL_PATH), "nsh");
	const listed = ARTIFACT_NSH_FILES.map((path) => relative(nsh, path)).sort();
	const present = [
		...(await readdir(join(nsh, "examples"))).map((name) => `examples/${name}`),
		...(await readdir(join(nsh, "kit"))).map((name) => `kit/${name}`),
	].sort();
	assert.deepEqual(listed, present, "ARTIFACT_NSH_FILES must list every example and helper source");
	const guide = await readFile(join(dirname(ARTIFACT_SKILL_PATH), "references", "nsh.md"), "utf8");
	for (const name of present.filter((name) => name.startsWith("examples/")))
		assert.ok(guide.includes(`](../nsh/${name})`), `nsh.md does not link ${name}`);
	for (const path of ARTIFACT_NSH_FILES) {
		const source = await readFile(path, "utf8");
		const imports = [...source.matchAll(/^import[^;]*?from "([^"]+)";/gms)].map((match) => match[1]);
		const allowed = path.includes("/kit/") ? /^(nsh|nsh\/base|\.\/[a-z]+)$/ : /^(nsh|nsh\/base|pilot-artifact\/ui)$/;
		for (const name of imports) assert.match(name, allowed, `${relative(nsh, path)} imports ${name}`);
		assert.doesNotMatch(
			source,
			/\b(host|Storage|Clipboard|Picker|openUrl|fetch|WebView)\b\s*[.(]/,
			relative(nsh, path),
		);
	}
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
