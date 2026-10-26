/**
 * Environment for the host commands pilotd runs inside a project.
 *
 * Two host behaviours break a background daemon in a workspace:
 *
 * - The host tool manager (mise) refuses to load a project config it does not trust, and it aborts
 *   every managed tool it starts there. Git's credential helper is usually one of them, so the fetch
 *   that authenticates the daemon produces no credentials and Git asks the user for a username that
 *   a daemon cannot answer. Pilot's workspaces are copies of the user's own project, so the daemon
 *   trusts the tool config inside its own directory: the host's trust database goes stale whenever
 *   the daemon refreshes a copy, and it must not decide whether the project's tools run there.
 * - Git inherits the desktop session's askpass helpers, so a missing credential turns into a prompt
 *   nobody can answer. The daemon never prompts: it fails with Git's own message instead.
 */
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

/** Pilot's own directory: the managed clones and session workspaces it creates. */
export function pilotHome(env: NodeJS.ProcessEnv = process.env): string {
	const dataHome = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
	return resolve(env.PILOT_HOME || join(dataHome, "pilot"));
}

/**
 * Trust the tool config of the project copies Pilot manages. Only configs under Pilot's own
 * directory are affected: the user's own checkout keeps the host's trust decision.
 */
export function toolTrustEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const home = pilotHome(env);
	const existing = env.MISE_TRUSTED_CONFIG_PATHS?.split(delimiter).filter(Boolean) ?? [];
	if (existing.includes(home)) return env;
	return { ...env, MISE_TRUSTED_CONFIG_PATHS: [...existing, home].join(delimiter) };
}

/**
 * Git never prompts in the daemon: a background service has nobody to answer. Askpass helpers are
 * dropped so a missing credential fails with Git's own message instead of an unanswerable dialog.
 */
export function gitPromptlessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const next = { ...env };
	delete next.GIT_ASKPASS;
	delete next.SSH_ASKPASS;
	next.GIT_TERMINAL_PROMPT = "0";
	return next;
}

/**
 * Git could not authenticate: the daemon holds no usable credential for this remote. The message
 * stays free of remote details, host paths and helper output.
 */
export function authenticationHint(message: string): string {
	return /could not read (Username|Password)|Authentication failed|terminal prompts disabled/i.test(message)
		? " Git could not authenticate: no credentials are available to the daemon for this remote."
		: "";
}

/** The environment every host command the daemon runs in a project directory receives. */
export function workspaceCommandEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return gitPromptlessEnvironment(toolTrustEnvironment(env));
}
