import { githubRepository } from "./github-url.ts";
import { sourceRemote } from "./source-copy.ts";
import { type Runner, run } from "./workspaces.ts";

/**
 * Each project's GitHub repository ("host/owner/name"), read once from its folder's git remote: origin, else the
 * remote `sourceRemote` picks. A local git config read with no network, done off the merge path so a merged PR can
 * be matched without blocking the event loop. Null: the project has no GitHub remote.
 */
export class ProjectRepositories {
	private readonly known = new Map<string, string | null>();
	private readonly reading = new Map<string, Promise<void>>();
	private readonly path: (projectId: string) => string | undefined;
	private readonly runner: Runner;
	constructor(path: (projectId: string) => string | undefined, runner: Runner = run) {
		this.path = path;
		this.runner = runner;
	}
	/** The repository read earlier, or undefined. A project not read yet starts a read for the next call. */
	get(projectId: string): string | undefined {
		if (!this.known.has(projectId)) void this.read(projectId);
		return this.known.get(projectId) ?? undefined;
	}
	/** Reads the project's remote. A failed read saves nothing, so a later call tries again. */
	read(projectId: string): Promise<void> {
		let pending = this.reading.get(projectId);
		if (!pending) {
			pending = (async () => {
				const path = this.path(projectId);
				if (!path) return;
				const remote = await sourceRemote(path, this.runner);
				let repository: string | null = null;
				try {
					const parsed = remote ? githubRepository(remote) : undefined;
					if (parsed?.host.toLowerCase() === "github.com") repository = parsed.identity;
				} catch {
					// A local path names no GitHub repository.
				}
				this.known.set(projectId, repository);
			})()
				.catch((error: unknown) =>
					console.warn(`pilotd: could not read the git remote of project ${projectId}: ${error}`),
				)
				.finally(() => this.reading.delete(projectId));
			this.reading.set(projectId, pending);
		}
		return pending;
	}
}
