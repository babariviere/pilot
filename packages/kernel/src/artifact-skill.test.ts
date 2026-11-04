import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { ARTIFACT_SKILL_FILES, ARTIFACT_SKILL_PATH, ARTIFACT_SKILL_REFERENCES } from "./artifact-skill.ts";

test("bundled artifact skill is valid and retains detailed authoring guidance outside the tool catalog", async () => {
	const loaded = loadSkillsFromDir({ dir: dirname(ARTIFACT_SKILL_PATH), source: "pilot" });
	assert.deepEqual(loaded.diagnostics, []);
	assert.equal(loaded.skills.length, 1);
	assert.equal(loaded.skills[0]!.name, "pilot-artifacts");
	assert.equal(loaded.skills[0]!.filePath, ARTIFACT_SKILL_PATH);
	assert.match(loaded.skills[0]!.description, /native visuals and images/);
	assert.match(loaded.skills[0]!.description, /Use before creating or updating/);
	assert.equal(loaded.skills[0]!.disableModelInvocation, false);
	const root = await readFile(ARTIFACT_SKILL_PATH, "utf8");
	// The root routes to every per-kind reference, and every route exists.
	for (const reference of ARTIFACT_SKILL_REFERENCES) {
		const relative = `references/${reference.split("/").at(-1)}`;
		assert.ok(root.includes(`](${relative})`), `SKILL.md does not route to ${relative}`);
	}
	const source = (await Promise.all(ARTIFACT_SKILL_FILES.map((path) => readFile(path, "utf8")))).join("\n");
	for (const guidance of [
		"Ask image sources must be inline base64",
		"Ask does not authorize shell execution",
		"512 KiB UTF-8",
		"16 MiB",
		"expectedRevision",
		"ui.mermaid",
		"String(visual)",
		"interface UI",
		"onChange",
		"workspace/credential access",
		"arbitrary npm imports",
		"read-only",
		"no artifact screenshot preview host",
	])
		assert.ok(source.includes(guidance), `missing ${guidance}`);
	assert.doesNotMatch(
		source,
		/kind: "(?:html|react|swiftui)"|echarts\.init|ArtifactView|mermaid\.initialize|motion\.animate|THREE\.Scene/,
	);
	assert.ok(!ARTIFACT_SKILL_REFERENCES.some((path) => /\/(web|swiftui)\.md$/.test(path)));
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
