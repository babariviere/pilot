import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { GitHubImportService, importRepository } from "./github-import.ts";
import { GitHubSetupService } from "./github-setup.ts";
import { DEFAULT_PROJECT_DESTINATION_PATTERN, projectDestination } from "./project-destination.ts";
import { ProjectStore } from "./projects.ts";
import { type ProcessOptions, type ProcessResult, subprocesses } from "./subprocess.ts";

const result = (stdout = "", code = 0, stderr = ""): ProcessResult => ({
	code,
	signal: null,
	stdout: Buffer.from(stdout),
	stderr,
	truncated: false,
	overflowed: false,
	timedOut: false,
	aborted: false,
});
const identity = { hostId: "execution-box", daemonId: "daemon", lineageId: "lineage" };
async function git(cwd: string, args: string[]) {
	const r = await subprocesses.run("git", args, {
		cwd,
		env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
		maxBytes: 65536,
		overflow: "fail",
		timeoutMs: 15000,
	});
	assert.equal(r.code, 0, r.stderr);
	return r;
}
function settled(service: GitHubImportService) {
	return new Promise<void>((resolve) => {
		const stop = service.onChange(() => {
			if (!service.blockers().length) {
				stop();
				resolve();
			}
		});
		if (!service.blockers().length) {
			stop();
			resolve();
		}
	});
}
async function fixture(t: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "github-import-"))),
		user = join(root, "user"),
		data = join(root, "data"),
		source = join(root, "source");
	await mkdir(user);
	await mkdir(source);
	await git(source, ["init", "-b", "main"]);
	await writeFile(join(source, "README.md"), "committed fixture\n");
	await writeFile(join(source, ".gitattributes"), "README.md filter=fixture\n");
	await git(source, ["add", "."]);
	await git(source, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"]);
	await writeFile(
		join(user, ".gitconfig"),
		`[filter "fixture"]\n smudge = touch ${join(user, "unsafe-filter-ran")}\n`,
	);
	let clones = 0,
		deny = false,
		failRegister = false,
		cancelClone = false;
	class Store extends ProjectStore {
		override async create(request: import("@pilot/protocol").ProjectRequest) {
			const project = await super.create(request);
			if (failRegister) {
				failRegister = false;
				throw new Error("lost register ack fixture-secret");
			}
			return project;
		}
	}
	const projects = new Store(data);
	await projects.load();
	let uploaded: string | undefined;
	const setup = new GitHubSetupService(data, identity, {
		userHome: user,
		env: { PATH: process.env.PATH },
		command: async (file, args, opts) => {
			if (file === "ssh-keygen") return subprocesses.run(file, args, opts);
			if (file === "ssh" && args.includes("-T"))
				return result(
					"",
					1,
					"Hi octocat! You've successfully authenticated, but GitHub does not provide shell access.",
				);
			if (args.join(" ") === "api user")
				return deny ? result("", 1, "fixture-secret SSO") : result('{"login":"octocat"}');
			if (args[0] === "api" && args[1]?.startsWith("user/keys?"))
				return result(JSON.stringify(uploaded ? [{ id: 1, key: uploaded }] : []));
			if (args.includes("POST")) {
				uploaded = args.at(-1)!.slice(4);
				return result("{}");
			}
			if (args[0] === "api" && args[1]?.startsWith("user/repos?")) {
				assert.ok(args.includes("--jq"));
				return result('[{"full_name":"owner/repo","private":true}]');
			}
			return result("{}");
		},
	});
	const key = await setup.act({ id: randomUUID(), action: "prepare_key" });
	const verified = await setup.act({
		id: randomUUID(),
		action: "approve_key",
		account: key.account,
		fingerprint: key.fingerprint,
	});
	assert.equal(verified.sshReady, true);
	const options = {
		command: async (file: string, args: string[], opts: ProcessOptions) => {
			assert.equal(file, "git");
			assert.equal(opts.env?.GIT_CONFIG_GLOBAL, "/dev/null");
			assert.equal(opts.env?.SSH_AUTH_SOCK, undefined);
			assert.match(opts.env?.GIT_SSH_COMMAND ?? "", /StrictHostKeyChecking=yes/);
			if (args.includes("clone")) {
				clones++;
				if (cancelClone)
					return new Promise<ProcessResult>((resolve) => {
						const done = () => resolve({ ...result(), aborted: true });
						opts.signal?.addEventListener("abort", done, { once: true });
						if (opts.signal?.aborted) done();
					});
				const target = args.at(-1)!;
				assert.equal(args.at(-2), "git@github.com:owner/repo.git");
				const replaced = [...args];
				replaced[replaced.length - 2] = source;
				const cloned = await subprocesses.run(
					file,
					[
						"-c",
						"protocol.file.allow=always",
						...replaced.filter(
							(_, i) =>
								!(
									i === args.indexOf("protocol.file.allow=never") ||
									i === args.indexOf("protocol.file.allow=never") - 1
								),
						),
					],
					opts,
				);
				if (cloned.code === 0) await git(target, ["remote", "set-url", "origin", "git@github.com:owner/repo.git"]);
				return cloned;
			}
			return subprocesses.run(file, args, opts);
		},
	};
	const service = new GitHubImportService(setup, projects, options);
	t.after(async () => {
		await service.close();
		await setup.close();
		await subprocesses.close();
		await rm(root, { recursive: true, force: true });
	});
	return {
		root,
		user,
		data,
		source,
		setup,
		projects,
		service,
		options,
		get clones() {
			return clones;
		},
		set deny(v: boolean) {
			deny = v;
		},
		set failRegister(v: boolean) {
			failRegister = v;
		},
		set cancelClone(v: boolean) {
			cancelClone = v;
		},
	};
}
const request = (destination: string) => ({ id: randomUUID(), url: "https://github.com/owner/repo", destination });

test("destination policy substitutes Git server, not execution host, and rejects unsafe patterns/components", () => {
	assert.equal(DEFAULT_PROJECT_DESTINATION_PATTERN, "~/src/{host}/{owner}/{repo}");
	assert.equal(
		projectDestination({ host: "github.com", owner: "babariviere", repo: "pilot" }),
		"~/src/github.com/babariviere/pilot",
	);
	for (const value of ["..", "../escape", "owner/name", "$(id)", "x\nsecret", "~root"])
		assert.throws(() => projectDestination({ host: "github.com", owner: value, repo: "repo" }));
	for (const pattern of ["/tmp/{repo}", "~/../{repo}", "~/{unknown}", "~/$HOME/{repo}", "~/src//{repo}"])
		assert.throws(() => projectDestination({ host: "github.com", owner: "owner", repo: "repo" }, pattern));
	for (const url of [
		"https://token@github.com/o/r",
		"https://github.com/o/r?q=secret",
		"git@evil.com:o/r",
		"https://github.com/o/../r",
		"--upload-pack=evil",
		"https://github.com/o/r#x",
		"https://github.com/o/r/extra",
	])
		assert.throws(() => importRepository(url));
	assert.equal(importRepository("git@github.com:owner/repo.git").url, "https://github.com/owner/repo");
});

test("preview expands selected host home, creates no files, then clone/register is idempotent and filter-free", async (t) => {
	const f = await fixture(t);
	const preview = await f.service.preview("https://github.com/owner/repo");
	assert.equal(preview.destination, "~/src/github.com/owner/repo");
	assert.equal(preview.resolvedDestination, join(f.user, "src/github.com/owner/repo"));
	await assert.rejects(readFile(join(f.user, "src")), /ENOENT/);
	const req = request(preview.resolvedDestination);
	await f.service.start(req);
	await settled(f.service);
	const op = (await f.service.list())[0]!;
	assert.equal(op.phase, "done", op.problem);
	assert.equal(f.clones, 1);
	assert.equal(await readFile(join(op.destination, "README.md"), "utf8"), "committed fixture\n");
	await assert.rejects(readFile(join(f.user, "unsafe-filter-ran")), /ENOENT/);
	await f.service.start(req);
	assert.equal(f.clones, 1);
	assert.equal(f.projects.list().length, 1);
	await assert.rejects(f.service.start({ ...req, url: "https://github.com/owner/other" }), /already bound/);
	const choices = await f.service.repositories("repo");
	assert.equal(choices.repositories[0]?.name, "owner/repo");
	assert.equal((await f.service.repositories("not-listed")).repositories.length, 0);
});

test("unrelated destinations and symlink/traversal expansions are never overwritten", async (t) => {
	const f = await fixture(t),
		path = join(f.user, "unrelated");
	await mkdir(path);
	await writeFile(join(path, "keep"), "keep");
	await f.service.start(request("unrelated"));
	await settled(f.service);
	assert.equal((await f.service.list())[0]?.phase, "failed");
	assert.equal(f.clones, 0);
	assert.equal(f.projects.list().length, 0);
	assert.equal(await readFile(join(path, "keep"), "utf8"), "keep");
	await symlink(f.source, join(f.user, "link"));
	for (const destination of [
		"../escape",
		"~/../escape",
		"$HOME/repo",
		"~someone/repo",
		"link/repo",
		".ssh/repo",
		"/tmp/not-home",
		"src/{repo}",
	])
		await assert.rejects(f.service.preview("https://github.com/owner/repo", destination));
});

test("existing checkout requires confirmation and revalidates identity and origin before registering", async (t) => {
	const f = await fixture(t),
		path = join(f.user, "existing");
	await git(f.user, ["clone", f.source, path]);
	await git(path, ["remote", "set-url", "origin", "https://github.com/owner/repo"]);
	const req = request("existing");
	await f.service.start(req);
	await settled(f.service);
	assert.equal((await f.service.list())[0]?.phase, "confirm_existing");
	assert.equal(f.projects.list().length, 0);
	await git(path, ["remote", "set-url", "origin", "https://github.com/owner/wrong"]);
	await f.service.action(req.id, "confirm_existing");
	await settled(f.service);
	assert.equal(f.projects.list().length, 0);
	assert.equal(f.clones, 0);
	await git(path, ["remote", "set-url", "origin", "https://github.com/owner/repo"]);
	await f.service.action(req.id, "resume");
	await settled(f.service);
	assert.equal((await f.service.list())[0]?.phase, "confirm_existing");
	await f.service.action(req.id, "confirm_existing");
	await settled(f.service);
	assert.equal(f.projects.list().length, 1);
	assert.equal(f.clones, 0);
});

test("lost registration completion reconciles after restart without duplicate clones or projects", async (t) => {
	const f = await fixture(t);
	f.failRegister = true;
	const req = request("reconcile");
	await f.service.start(req);
	await settled(f.service);
	assert.equal(f.projects.list().length, 1);
	assert.equal(f.clones, 1);
	const recovered = new GitHubImportService(f.setup, f.projects, f.options);
	await recovered.action(req.id, "resume");
	await settled(recovered);
	assert.equal((await recovered.list())[0]?.phase, "done");
	assert.equal(f.projects.list().length, 1);
	assert.equal(f.clones, 1);
	const disk = await readFile(join(f.data, "github-import/operations.json"), "utf8");
	assert.ok(!disk.includes("fixture-secret"));
	await recovered.close();
});

test("missing/SSO auth fails safely; cancellation and update blockers wait for clone exit", async (t) => {
	const f = await fixture(t);
	f.deny = true;
	await f.service.start(request("denied"));
	await settled(f.service);
	assert.equal(f.clones, 0);
	assert.match((await f.service.list())[0]!.problem!, /Connect GitHub/);
	f.deny = false;
	f.cancelClone = true;
	const req = request("cancelled");
	await f.service.start(req);
	const freeze = f.service.freezeAdmissions();
	await assert.rejects(f.service.start(request("frozen")), /frozen/);
	freeze();
	assert.equal(f.service.blockers().length, 1);
	await f.service.action(req.id, "cancel");
	await settled(f.service);
	assert.equal((await f.service.list()).find((op) => op.id === req.id)?.phase, "cancelled");
	assert.equal(f.projects.list().length, 0);
});
