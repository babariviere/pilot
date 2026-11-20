/** Local capability probe, once per worker open. Never installs an extension or contacts GitHub. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
type Probe = (cwd: string) => Promise<string>;
const probe: Probe = async (cwd) => {
	const { stdout } = await exec("gh", ["extension", "list"], {
		cwd,
		timeout: 2_000,
		maxBuffer: 64 * 1024,
		killSignal: "SIGKILL",
	});
	return stdout;
};

export async function detectGhStack(cwd: string, run: Probe = probe): Promise<boolean> {
	try {
		return (await run(cwd)).split("\n").some((line) => /^gh stack\s+github\/gh-stack(?:\s|$)/.test(line.trim()));
	} catch {
		// Missing gh, a failed probe or a timeout all use ordinary dependent-base PRs.
		return false;
	}
}
