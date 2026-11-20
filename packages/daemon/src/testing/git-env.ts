/** Git environment for tests, fixtures and benchmarks: no user or system configuration and a fixed author, so
 * commits do not depend on the machine. */
export function hermeticGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return {
		...env,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "t",
		GIT_AUTHOR_EMAIL: "t@t",
		GIT_COMMITTER_NAME: "t",
		GIT_COMMITTER_EMAIL: "t@t",
	};
}
