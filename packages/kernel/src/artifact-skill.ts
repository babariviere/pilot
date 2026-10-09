import { fileURLToPath } from "node:url";

/** Bundled with the kernel, independent of the session's cwd, user packages or the macOS UI. */
export const ARTIFACT_SKILL_PATH = fileURLToPath(new URL("../skills/pilot-artifacts/SKILL.md", import.meta.url));
