import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixture, git, jj } from "./testing/shared-workspace.ts";
import { run } from "./workspaces.ts";

for (const scenario of [
	"squash",
	"dirty",
	"late-dirty",
	"omitted",
	"unpushed",
	"unpublished-other",
	"source-branch",
	"missing-head",
	"empty",
	"fetch-failure",
] as const) {
	test(`merged workspace refresh: ${scenario}`, async () => {
		let head = "";
		let main = "";
		let failFetch = false;
		const f = fixture(async (file, args, ...rest) => {
			if (file === "gh") {
				if (scenario === "late-dirty") writeFileSync(join(rest[0], "late.txt"), "new work during lookup\n");
				return JSON.stringify({
					state: "MERGED",
					headRefOid: scenario === "missing-head" ? "f".repeat(40) : head,
					isCrossRepository: false,
					baseRefName: "main",
					mergeCommit: { oid: main },
				});
			}
			if (failFetch && file === "git" && args.includes("fetch")) throw new Error("offline");
			return run(file, args, ...rest);
		});
		try {
			const owner = await f.store.create(f.source, f.path());
			const coordinator = await f.store.create(f.source, f.path("lead"));
			writeFileSync(join(owner.path, "first.txt"), "first commit\n");
			jj(owner.path, "commit", "-m", "first part");
			writeFileSync(join(owner.path, "second.txt"), "second commit\n");
			jj(owner.path, "commit", "-m", "second part");
			jj(owner.path, "bookmark", "create", "fix/completed", "-r", "@-");
			head = jj(owner.path, "log", "--no-graph", "-r", "fix/completed", "-T", "commit_id");
			const target = scenario === "empty" ? coordinator : owner;
			if (scenario === "dirty") writeFileSync(join(target.path, "dirty.txt"), "next work\n");
			if (scenario === "omitted") {
				jj(target.path, "config", "set", "--repo", "snapshot.auto-track", "none()");
				writeFileSync(join(target.path, "omitted.txt"), "must preserve\n");
			}
			if (scenario === "unpushed") jj(target.path, "bookmark", "create", "fix/next", "-r", "@");
			if (scenario === "unpublished-other") {
				jj(target.path, "new", target.base);
				writeFileSync(join(target.path, "later.txt"), "unpublished other branch\n");
				jj(target.path, "commit", "-m", "later work");
				jj(target.path, "bookmark", "create", "fix/later", "-r", "@-");
				jj(target.path, "new", head);
			}
			const pr = {
				number: 1,
				url: "https://github.com/o/r/pull/1",
				title: "Combined",
				state: "merged" as const,
				branch: "fix/completed",
				checkedAt: Date.now(),
			};
			const siblingBefore = jj(coordinator.path, "log", "--no-graph", "-r", "@", "-T", "commit_id");
			writeFileSync(join(f.source, "first.txt"), "first commit\n");
			writeFileSync(join(f.source, "second.txt"), "second commit\n");
			jj(f.source, "commit", "-m", "squash merge");
			jj(f.source, "bookmark", "set", "main", "-r", "@-");
			main = git(f.source, "rev-parse", "refs/heads/main");
			if (scenario === "source-branch") git(f.source, "checkout", "-b", "other", owner.base);
			if (scenario === "fetch-failure") {
				git(f.source, "remote", "add", "origin", f.source);
				failFetch = true;
			}
			if (scenario === "fetch-failure") {
				await assert.rejects(f.store.fetchMain(target.shared!, f.source), /offline|fetch/);
			} else {
				const fetched = await f.store.fetchMain(target.shared!, f.source);
				const refresh = () =>
					f.store.refreshBase(target.path, target.shared!, f.source, target.base, undefined, {
						target: fetched,
						mergedPrs: scenario === "empty" ? [] : [pr],
					});
				if (scenario === "omitted") {
					await assert.rejects(refresh(), /omitted/);
				} else {
					const result = await refresh();
					if (["dirty", "late-dirty", "unpushed", "unpublished-other", "missing-head"].includes(scenario)) {
						assert.ok("behind" in result, JSON.stringify(result));
						assert.match(result.behind!, /unpublished|changed during|unpushed|not available locally/);
						assert.equal(jj(target.path, "log", "--no-graph", "-r", "@-", "-T", "commit_id"), head);
					} else {
						assert.equal(result.base, main);
						assert.equal(
							jj(
								target.path,
								"log",
								"--no-graph",
								"-r",
								"@ & empty()",
								"-T",
								'parents.map(|p| p.commit_id()).join("")',
							),
							main,
						);
					}
				}
			}
			assert.equal(
				jj(owner.path, "--ignore-working-copy", "log", "--no-graph", "-r", "fix/completed", "-T", "commit_id"),
				head,
				"merged bookmark never moves",
			);
			if (scenario !== "empty")
				assert.equal(
					jj(coordinator.path, "--ignore-working-copy", "log", "--no-graph", "-r", "@", "-T", "commit_id"),
					siblingBefore,
				);
			assert.ok(existsSync(join(target.path, ".git")));
		} finally {
			f.close();
		}
	});
}

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
			if (scenario === "clean") {
				assert.equal(git(a.shared!.repository, "rev-parse", "refs/heads/fix/sibling"), a.base);
				// Only the newest base keeps an import bookmark; the earlier base stays visible without one.
				assert.equal(
					git(a.shared!.repository, "for-each-ref", "--format=%(refname)", "refs/remotes/pilot-base/"),
					`refs/remotes/pilot-base/${main}`,
				);
				const control = join(a.shared!.repository, ".jj/pilot-control");
				assert.equal(
					jj(
						control,
						"--ignore-working-copy",
						"bookmark",
						"list",
						"--remote",
						"pilot-base",
						"-T",
						'name ++ "\\n"',
					),
					main,
				);
				assert.equal(
					jj(
						control,
						"--ignore-working-copy",
						"log",
						"--no-graph",
						"-r",
						`${a.base} & ::visible_heads()`,
						"-T",
						"commit_id",
					),
					a.base,
				);
			}
		} finally {
			f.close();
		}
	});
}
