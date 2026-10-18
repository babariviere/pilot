import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitHubSetupService } from "./github-setup.ts";

/** Only new daemon children. Never rewrite SSH/Git configuration or override explicit Git transports. */
export async function installGitHubTransport(setup: GitHubSetupService, env: NodeJS.ProcessEnv = process.env) {
	const state = await setup.status();
	if (!state.keyId || !state.publicKey || env.GIT_SSH || env.GIT_SSH_COMMAND) return;
	await installGitHubKeyTransport(setup.home, setup.keyPath, env);
}

/** Used while recovering host state, before the setup service's readiness promise is resolved. */
export async function installGitHubKeyTransport(home: string, keyPath: string, env: NodeJS.ProcessEnv) {
	if (env.GIT_SSH || env.GIT_SSH_COMMAND) return;
	const file = join(home, "github-setup", "git-ssh");
	const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
	const script = `#!/bin/sh
github_target() {
 while [ "$#" -gt 0 ]; do
  case "$1" in
   -o|-p|-l|-i|-F|-J) [ "$#" -ge 2 ] || return 1; shift 2 ;;
   --) shift; break ;;
   -*) shift ;;
   *) break ;;
  esac
 done
 [ "\${1-}" = git@github.com ] || [ "\${1-}" = github.com ]
}
if github_target "$@"; then
 exec ssh -i ${quote(keyPath)} -o IdentitiesOnly=yes -o IdentityAgent=none -o ForwardAgent=no -o BatchMode=yes -o StrictHostKeyChecking=yes "$@"
fi
exec ssh "$@"
`;
	const temp = `${file}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, script, { mode: 0o700, flag: "wx" });
		await rename(temp, file);
	} finally {
		await unlink(temp).catch(() => {});
	}
	if (!env.GIT_SSH && !env.GIT_SSH_COMMAND) env.GIT_SSH = file;
}
