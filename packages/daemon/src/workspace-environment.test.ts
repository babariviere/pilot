import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "./workspaces.ts";
import {
	authenticationHint,
	gitPromptlessEnvironment,
	pilotHome,
	toolTrustEnvironment,
	workspaceCommandEnvironment,
} from "./workspace-environment.ts";

test("the pilot directory is the host trust boundary for the project copies the daemon manages", () => {
	const env = { PILOT_HOME: "/tmp/pilot-home", XDG_DATA_HOME: "/tmp/data" };
	assert.equal(pilotHome(env), "/tmp/pilot-home");
	assert.equal(pilotHome({ XDG_DATA_HOME: "/tmp/data" }), "/tmp/data/pilot");
});

test("the project tool config of the managed copies is trusted without discarding the host own trust", () => {
	const trusted = toolTrustEnvironment({ PILOT_HOME: "/tmp/pilot-home", MISE_TRUSTED_CONFIG_PATHS: "/tmp/mine" });
	assert.equal(trusted.MISE_TRUSTED_CONFIG_PATHS, "/tmp/mine:/tmp/pilot-home");
	const repeated = toolTrustEnvironment(trusted);
	assert.equal(repeated.MISE_TRUSTED_CONFIG_PATHS, "/tmp/mine:/tmp/pilot-home");
	assert.equal(toolTrustEnvironment({ PILOT_HOME: "/tmp/pilot-home" }).MISE_TRUSTED_CONFIG_PATHS, "/tmp/pilot-home");
});

test("git never prompts for credentials in the daemon", () => {
	const env = gitPromptlessEnvironment({
		GIT_ASKPASS: "/usr/bin/ksshaskpass",
		SSH_ASKPASS: "/usr/bin/ksshaskpass",
		GIT_TERMINAL_PROMPT: "1",
		GIT_SSH_COMMAND: "ssh -i key",
		PATH: "/usr/bin",
	});
	assert.equal(env.GIT_ASKPASS, undefined);
	assert.equal(env.SSH_ASKPASS, undefined);
	assert.equal(env.GIT_TERMINAL_PROMPT, "0");
	assert.equal(env.GIT_SSH_COMMAND, "ssh -i key");
	assert.equal(env.PATH, "/usr/bin");
});

test("the workspace command environment keeps the host environment and adds both policies", () => {
	const env = workspaceCommandEnvironment({ PILOT_HOME: "/tmp/pilot-home", PATH: "/usr/bin", HOME: "/home/me" });
	assert.equal(env.MISE_TRUSTED_CONFIG_PATHS, "/tmp/pilot-home");
	assert.equal(env.GIT_TERMINAL_PROMPT, "0");
	assert.equal(env.PATH, "/usr/bin");
	assert.equal(env.HOME, "/home/me");
});

test("only an authentication failure is reported as a missing credential", () => {
	assert.equal(
		authenticationHint("fatal: could not read Username for 'https://github.com'"),
		" Git could not authenticate: no credentials are available to the daemon for this remote.",
	);
	assert.equal(
		authenticationHint("fatal: Authentication failed for 'https://github.com/'"),
		" Git could not authenticate: no credentials are available to the daemon for this remote.",
	);
	assert.equal(
		authenticationHint("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
		" Git could not authenticate: no credentials are available to the daemon for this remote.",
	);
	assert.equal(authenticationHint("fatal: repository not found"), "");
});

test("workspace commands run with the trusted project config and without any credential prompt", async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-workspace-environment-"));
	try {
		const output = await run(
			process.execPath,
			[
				"-e",
				"process.stdout.write(JSON.stringify({prompt: process.env.GIT_TERMINAL_PROMPT, askpass: process.env.GIT_ASKPASS, trusted: process.env.MISE_TRUSTED_CONFIG_PATHS}))",
			],
			root,
		);
		const seen = JSON.parse(output) as { prompt?: string; askpass?: string; trusted?: string };
		assert.equal(seen.prompt, "0");
		assert.equal(seen.askpass, undefined);
		assert.equal(seen.trusted, pilotHome());
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
