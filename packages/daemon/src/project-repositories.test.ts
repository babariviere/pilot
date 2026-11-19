import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProjectRepositories } from "./project-repositories.ts";

test("a project's GitHub repository comes from origin, else its only remote, with no network", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "project-repositories-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const repo = (name: string, remotes: [string, string][]) => {
		const path = join(home, name);
		execFileSync("git", ["init", "-q", path]);
		for (const [remote, url] of remotes) execFileSync("git", ["-C", path, "remote", "add", remote, url]);
		return path;
	};
	const paths: Record<string, string> = {
		origin: repo("origin", [
			["fork", "https://github.com/me/r.git"],
			["origin", "git@github.com:Org/Repo.git"],
		]),
		only: repo("only", [["upstream", "https://github.com/stoikio/eventbus-schema"]]),
		none: repo("none", []),
		other: repo("other", [["origin", "https://gitlab.com/o/r.git"]]),
	};
	const repositories = new ProjectRepositories((id) => paths[id]);
	assert.equal(repositories.get("origin"), undefined, "the first call starts the read and does not wait");
	await Promise.all(Object.keys(paths).map((id) => repositories.read(id)));
	assert.equal(repositories.get("origin"), "github.com/Org/Repo");
	assert.equal(repositories.get("only"), "github.com/stoikio/eventbus-schema");
	assert.equal(repositories.get("none"), undefined);
	assert.equal(repositories.get("other"), undefined);
	assert.equal(repositories.get("missing"), undefined);
});
