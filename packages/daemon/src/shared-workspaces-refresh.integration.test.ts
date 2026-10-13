import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixture, git, jj } from "./testing/shared-workspace.ts";
import { run } from "./workspaces.ts";

for (const scenario of [
	"clean",
	"long-idle",
	"squash-merged",
	"on-upstream",
	"unconfigured-author",
	"own",
	"conflict",
	"shared",
	"foreign-bookmark",
	"foreign-descendant",
] as const) {
	test(`base refresh: ${scenario} preserves sibling changes and bookmarks`, async () => {
		let refreshing = false;
		const f = fixture(async (file, args, ...rest) => {
			if (file === "jj" && scenario === "unconfigured-author")
				args = ["--config=user.name=", "--config=user.email=", ...args];
			if (
				refreshing &&
				scenario === "long-idle" &&
				args.includes("op") &&
				args.includes("log") &&
				args.some((arg) => arg.includes("workspace_name()"))
			)
				return "";
			return run(file, args, ...rest);
		});
		try {
			const a = await f.store.create(f.source, f.path());
			const b = await f.store.create(f.source, f.path("session-b"));
			if (scenario === "long-idle") jj(a.path, "new", "@");
			if (scenario === "on-upstream") jj(a.path, "--ignore-immutable", "edit", a.base);
			let completed: string | undefined;
			if (scenario === "squash-merged") {
				writeFileSync(join(a.path, "own.txt"), "completed implementation\n");
				jj(a.path, "commit", "-m", "implementation");
				jj(a.path, "bookmark", "create", "fix/completed", "-r", "@-");
				completed = jj(a.path, "log", "--no-graph", "-r", "@-", "-T", "commit_id");
				writeFileSync(join(f.source, "own.txt"), "completed implementation\n");
				jj(f.source, "commit", "-m", "squash merge");
				writeFileSync(join(f.source, "own.txt"), "newer implementation\n");
			}
			if (scenario === "own" || scenario === "conflict") {
				writeFileSync(join(a.path, scenario === "own" ? "own.txt" : "a.txt"), "own change\n");
				jj(a.path, "commit", "-m", "own commit");
				writeFileSync(join(a.path, "dirty.txt"), "dirty own\n");
			}
			writeFileSync(join(b.path, "sibling.txt"), "sibling\n");
			jj(b.path, "bookmark", "create", "fix/sibling", "-r", "@");
			const sibling = jj(b.path, "log", "--no-graph", "-r", "@", "-T", "commit_id");
			if (scenario === "shared") jj(a.path, "new", "fix/sibling");
			const before = jj(a.path, "log", "--no-graph", "-r", "@", "-T", "commit_id");
			if (scenario === "foreign-bookmark") jj(b.path, "bookmark", "create", "fix/foreign", "-r", before);
			if (scenario === "foreign-descendant") jj(b.path, "new", before);
			const siblingWorkingCopy = jj(
				b.path,
				"--ignore-working-copy",
				"log",
				"--no-graph",
				"-r",
				"@",
				"-T",
				"commit_id",
			);
			// Publish a new local main through the same private base import used for startup.
			writeFileSync(join(f.source, "a.txt"), "new main\n");
			jj(f.source, "commit", "-m", "new main");
			jj(f.source, "bookmark", "set", "main", "-r", "@-");
			const main = git(f.source, "rev-parse", "refs/heads/main");
			if (scenario === "clean") {
				// Stale working copy plus a deliberately stale agent Git ref. Neither should be imported.
				jj(
					join(a.shared!.repository, ".jj/pilot-control"),
					"--ignore-working-copy",
					"describe",
					"-r",
					before,
					"-m",
					"updated description",
				);
				git(a.shared!.repository, "update-ref", "refs/heads/fix/sibling", a.base);
			}
			refreshing = true;
			const result = await f.store.refreshBase(a.path, a.shared!, f.source, a.base);
			assert.equal(
				jj(b.path, "--ignore-working-copy", "log", "--no-graph", "-r", "fix/sibling", "-T", "commit_id"),
				sibling,
			);
			assert.equal(
				jj(b.path, "--ignore-working-copy", "log", "--no-graph", "-r", "@", "-T", "commit_id"),
				siblingWorkingCopy,
			);
			if (
				scenario === "conflict" ||
				scenario === "shared" ||
				scenario === "foreign-bookmark" ||
				scenario === "foreign-descendant"
			) {
				assert.ok("behind" in result, JSON.stringify(result));
				assert.equal(result.base, a.base);
				assert.equal(jj(a.path, "log", "--no-graph", "-r", "@", "-T", "commit_id"), before);
			} else {
				assert.equal(result.base, main, JSON.stringify(result));
				assert.equal(readFileSync(join(a.path, "a.txt"), "utf8"), "new main\n");
				assert.equal(jj(a.path, "log", "--no-graph", "-r", `${main} & ::@`, "-T", "commit_id"), main);
				if (scenario === "own") {
					assert.equal(readFileSync(join(a.path, "own.txt"), "utf8"), "own change\n");
					assert.equal(readFileSync(join(a.path, "dirty.txt"), "utf8"), "dirty own\n");
				}
			}
			assert.ok(existsSync(join(a.path, ".git")));
			if (scenario === "squash-merged") {
				assert.equal(readFileSync(join(a.path, "own.txt"), "utf8"), "newer implementation\n");
				assert.equal(jj(a.path, "log", "--no-graph", "-r", "fix/completed", "-T", "commit_id"), completed);
			}
			if (scenario === "clean")
				assert.equal(git(a.shared!.repository, "rev-parse", "refs/heads/fix/sibling"), a.base);
		} finally {
			f.close();
		}
	});
}
