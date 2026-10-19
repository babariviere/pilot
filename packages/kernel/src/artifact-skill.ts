import { fileURLToPath } from "node:url";

/** Bundled with the kernel, independent of the session's cwd, user packages or the macOS UI. */
export const ARTIFACT_SKILL_PATH = fileURLToPath(new URL("../skills/pilot-artifacts/SKILL.md", import.meta.url));

/** Per-kind references SKILL.md routes to, so agents read only the part a task needs. */
export const ARTIFACT_SKILL_REFERENCES = [
	"visuals.md",
	"visual.d.ts",
	"web.md",
	"swiftui.md",
	"images.md",
	"shaders.md",
].map((name) => fileURLToPath(new URL(`../skills/pilot-artifacts/references/${name}`, import.meta.url)));

/** The exact bundled skill documents. Ask may read these paths and nothing else outside its source. */
export const ARTIFACT_SKILL_FILES: readonly string[] = [ARTIFACT_SKILL_PATH, ...ARTIFACT_SKILL_REFERENCES];
