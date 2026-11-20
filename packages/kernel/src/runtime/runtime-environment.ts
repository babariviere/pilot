/** Headless services inherit a sparse environment. Never source login files or copy another host's env. */
import { accessSync, constants, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

export function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

export function resolveLoginShell(
	env: NodeJS.ProcessEnv = process.env,
	platform: string = process.platform,
	executable = isExecutable,
	accountShell: () => string | null = () => userInfo().shell,
): string {
	if (env.SHELL && isAbsolute(env.SHELL) && executable(env.SHELL)) return env.SHELL;
	let configured: string | null = null;
	try {
		configured = accountShell();
	} catch {
		// Minimal containers may have no passwd entry. Check real executables below.
	}
	const candidates = [configured, ...(platform === "darwin" ? ["/bin/zsh"] : []), "/bin/bash", "/bin/sh"];
	for (const path of candidates) if (path && isAbsolute(path) && executable(path)) return path;
	throw new Error("No executable login shell found (SHELL, account shell, bash or sh)");
}

export function runtimeEnvironment(
	env: NodeJS.ProcessEnv = process.env,
	options: { platform?: string; home?: string; execPath?: string } = {},
): NodeJS.ProcessEnv {
	const platform = options.platform ?? process.platform;
	const home = options.home ?? env.HOME ?? homedir();
	const paths = [
		...(env.PATH ?? "").split(delimiter).filter(Boolean),
		dirname(options.execPath ?? process.execPath),
		join(home, ".local", "bin"),
		...(platform === "darwin" ? ["/opt/homebrew/bin", "/opt/homebrew/sbin"] : []),
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
		"/usr/local/sbin",
		"/usr/sbin",
		"/sbin",
	];
	return { ...env, PATH: [...new Set(paths)].join(delimiter), SHELL: resolveLoginShell(env, platform) };
}
