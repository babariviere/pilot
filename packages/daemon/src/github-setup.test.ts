import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { installGitHubTransport } from "./github-git-transport.ts";
import { GitHubSetupService } from "./github-setup.ts";
import { type ProcessResult, subprocesses } from "./subprocess.ts";

const identity = { hostId: "box", daemonId: "daemon", lineageId: "lineage" };
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
async function fixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "github-setup-"));
	t.after(async () => {
		await subprocesses.close();
		await rm(home, { recursive: true, force: true });
	});
	let loggedIn = true,
		uploads = 0,
		revokes = 0,
		lostUpload = false,
		sshAccount = "octocat",
		missing = false;
	const keys: { id: number; key: string }[] = [];
	const calls: { file: string; args: string[]; stdin?: string }[] = [];
	const options = {
		userHome: home,
		env: { PATH: process.env.PATH, SSH_AUTH_SOCK: "mac-agent" },
		command: async (file: string, args: string[], opts: import("./subprocess.ts").ProcessOptions) => {
			assert.equal(opts.env?.GH_TOKEN, undefined);
			assert.equal(opts.env?.SSH_AUTH_SOCK, undefined);
			assert.equal(opts.env?.HOME, home);
			assert.ok(opts.timeoutMs! <= 15000);
			assert.ok(opts.maxBytes <= 128 * 1024);
			calls.push({ file, args, ...(opts.stdin ? { stdin: opts.stdin } : {}) });
			if (missing) throw new Error("ENOENT private-token");
			if (file === "ssh-keygen") return subprocesses.run(file, args, opts);
			if (file === "ssh" && args.includes("-T")) {
				for (const gate of [
					"StrictHostKeyChecking=yes",
					"ForwardAgent=no",
					"IdentityAgent=none",
					"IdentitiesOnly=yes",
				])
					assert.ok(args.includes(gate));
				return result(
					"",
					1,
					`Hi ${sshAccount}! You've successfully authenticated, but GitHub does not provide shell access.`,
				);
			}
			if (file === "gh" && args[0] === "auth") {
				loggedIn = true;
				return result();
			}
			if (args.join(" ") === "api user")
				return loggedIn ? result(JSON.stringify({ login: "octocat" })) : result("", 1, "private-token SSO");
			if (args[0] === "api" && args[1]?.startsWith("user/keys?")) return result(JSON.stringify(keys));
			if (args.includes("POST")) {
				uploads++;
				keys.push({ id: 42, key: args.at(-1)!.slice(4) });
				return lostUpload ? result("", 1, "private-token") : result("{}");
			}
			if (args.includes("DELETE")) {
				revokes++;
				keys.length = 0;
				return result();
			}
			return result();
		},
	};
	const service = new GitHubSetupService(home, identity, options);
	await service.status();
	return {
		home,
		service,
		options,
		calls,
		keys,
		get uploads() {
			return uploads;
		},
		get revokes() {
			return revokes;
		},
		set loggedIn(v: boolean) {
			loggedIn = v;
		},
		set lostUpload(v: boolean) {
			lostUpload = v;
		},
		set missing(v: boolean) {
			missing = v;
		},
		set sshAccount(v: string) {
			sshAccount = v;
		},
	};
}
const action = (
	action: "verify" | "prepare_key" | "approve_key" | "revoke_key" | "authorize" | "cancel",
	approval: { account?: string; fingerprint?: string } = {},
) => ({ id: randomUUID(), action, ...approval });
function idle(service: GitHubSetupService) {
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

test("native capability, exact key approval, independent identity verification and revocation", async (t) => {
	const f = await fixture(t);
	await assert.rejects(f.service.authenticate("not-app"), /native app/);
	const token = JSON.parse(await readFile(join(f.home, "github-app-capability"), "utf8")).token;
	await f.service.authenticate(token);
	const prepared = await f.service.act(action("prepare_key"));
	assert.equal(prepared.account, "octocat");
	assert.equal(prepared.phase, "key_ready");
	assert.ok(prepared.fingerprint);
	assert.equal(f.uploads, 0, "Generating a key does not approve uploading it");
	await f.service.act(action("approve_key", { account: "other", fingerprint: prepared.fingerprint }));
	assert.equal(f.uploads, 0);
	const approval = action("approve_key", { account: prepared.account, fingerprint: prepared.fingerprint });
	const ready = await f.service.act(approval);
	assert.equal(ready.sshReady, true);
	assert.equal(ready.apiReady, true);
	assert.equal(f.uploads, 1);
	await f.service.act(approval);
	assert.equal(f.uploads, 1);
	f.sshAccount = "wrong-account";
	const mismatch = await f.service.act(action("verify"));
	assert.equal(mismatch.sshReady, false);
	assert.equal(mismatch.apiReady, true, "SSH identity failure must not erase a successful independent API check");
	await f.service.act(action("revoke_key", { account: prepared.account, fingerprint: prepared.fingerprint }));
	assert.equal(f.revokes, 1);
	assert.equal((await f.service.status()).keyId, undefined);
	const disk = await readFile(join(f.home, "github-setup/state.json"), "utf8");
	assert.ok(!disk.includes("PRIVATE KEY"));
	assert.ok(!disk.includes("private-token"));
});

test("lost upload response reconciles exact remote key and restart never replays approval", async (t) => {
	const f = await fixture(t);
	f.lostUpload = true;
	const key = await f.service.act(action("prepare_key"));
	const approval = action("approve_key", { account: key.account, fingerprint: key.fingerprint });
	assert.equal((await f.service.act(approval)).phase, "ready");
	const recovered = new GitHubSetupService(f.home, identity, f.options);
	await recovered.act(approval);
	assert.equal(f.uploads, 1);
	assert.equal((await recovered.status()).sshReady, false, "Recovered readiness must be checked again");
	assert.equal((await recovered.act(action("verify"))).sshReady, true);
	const release = recovered.freezeAdmissions();
	await assert.rejects(recovered.act(action("prepare_key")), /frozen/);
	release();
});

test("missing tools, existing denied/revoked login and mismatched requests never install or overwrite", async (t) => {
	const f = await fixture(t);
	f.missing = true;
	assert.ok((await f.service.act(action("prepare_key"))).problem);
	assert.ok(!(await f.service.status()).problem?.includes("private-token"));
	f.missing = false;
	f.loggedIn = false;
	await mkdir(join(f.home, ".config/gh"), { recursive: true });
	await writeFile(join(f.home, ".config/gh/hosts.yml"), "github.com:\n  oauth_token: remote-existing\n");
	const state = await f.service.act(action("authorize"));
	assert.match(state.problem!, /already exists/);
	assert.equal(
		f.calls.some((c) => c.args[0] === "auth"),
		false,
	);
	await assert.rejects(f.service.act({ ...action("verify"), extra: "grant" } as never), /Invalid/);
});

test("device authorization stays remote, is bounded/cancellable and never persists challenges or tokens", async (t) => {
	const f = await fixture(t);
	f.loggedIn = false;
	let exchange = false;
	const service = new GitHubSetupService(f.home, identity, {
		...f.options,
		wait: async (_ms, signal) => {
			if (signal.aborted) throw new Error("cancelled");
		},
		fetch: async (url, opts) => {
			assert.equal(opts?.redirect, "error");
			if (String(url).endsWith("device/code"))
				return Response.json({
					device_code: "device-private",
					user_code: "ABCD-EFGH",
					verification_uri: "https://github.com/login/device",
					expires_in: 600,
				});
			exchange = true;
			return Response.json({ access_token: "gho_remote_fixture_token_1234567890" });
		},
	});
	const started = await service.act(action("authorize"));
	assert.equal(started.challenge?.code, "ABCD-EFGH");
	await idle(service);
	assert.equal(exchange, true);
	assert.equal((await service.status()).apiReady, true);
	assert.equal(f.calls.find((c) => c.args.includes("--with-token"))?.stdin, "gho_remote_fixture_token_1234567890\n");
	const disk = await readFile(join(f.home, "github-setup/state.json"), "utf8");
	for (const secret of ["ABCD-EFGH", "device-private", "gho_remote_fixture"]) assert.ok(!disk.includes(secret));
	assert.equal((await service.status()).challenge, undefined);
});

test("denied auth and cancellation settle before admitting another auth, with no credential write", async (t) => {
	const f = await fixture(t);
	f.loggedIn = false;
	const service = new GitHubSetupService(f.home, identity, {
		...f.options,
		fetch: async () =>
			Response.json({
				device_code: "private",
				user_code: "ABCD-EFGH",
				verification_uri: "https://github.com/login/device",
				expires_in: 600,
			}),
	});
	await service.act(action("authorize"));
	assert.equal(service.blockers().length, 1);
	await service.act(action("cancel"));
	await idle(service);
	assert.equal((await service.status()).phase, "interrupted");
	assert.equal(
		f.calls.some((c) => c.args.includes("--with-token")),
		false,
	);
	const denied = new GitHubSetupService(f.home, identity, {
		...f.options,
		wait: async () => {},
		fetch: async (url) =>
			String(url).endsWith("device/code")
				? Response.json({
						device_code: "private",
						user_code: "ABCD-EFGH",
						verification_uri: "https://github.com/login/device",
						expires_in: 600,
					})
				: Response.json({ error: "access_denied" }),
	});
	await denied.act(action("authorize"));
	await idle(denied);
	assert.match((await denied.status()).problem!, /denied or expired/);
});

test("verified dedicated key routes new GitHub children only, preserving explicit transports and other hosts", async (t) => {
	const f = await fixture(t);
	const prepared = await f.service.act(action("prepare_key"));
	await f.service.act(action("approve_key", { account: prepared.account, fingerprint: prepared.fingerprint }));
	const explicit: NodeJS.ProcessEnv = { GIT_SSH_COMMAND: "existing-command" };
	await installGitHubTransport(f.service, explicit);
	assert.equal(explicit.GIT_SSH, undefined);
	const env: NodeJS.ProcessEnv = {};
	await installGitHubTransport(f.service, env);
	assert.ok(env.GIT_SSH);
	const bin = join(f.home, "bin");
	await mkdir(bin);
	await writeFile(join(bin, "ssh"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
	const invoke = (args: string[]) =>
		subprocesses.run(env.GIT_SSH!, args, { env: { PATH: `${bin}:/usr/bin:/bin` }, maxBytes: 8192, overflow: "fail" });
	assert.equal(
		(await invoke(["-o", "SendEnv=GIT_PROTOCOL", "git@example.test", "git-upload-pack 'repo'"])).stdout.toString(),
		"-o\nSendEnv=GIT_PROTOCOL\ngit@example.test\ngit-upload-pack 'repo'\n",
	);
	const github = (await invoke(["git@github.com", "git-upload-pack 'owner/repo'"])).stdout.toString();
	for (const option of ["IdentityAgent=none", "StrictHostKeyChecking=yes", "ForwardAgent=no"])
		assert.ok(github.includes(option));
});

test("environment credentials are never replaced or confused with stored CLI readiness", async (t) => {
	const f = await fixture(t);
	f.loggedIn = false;
	const service = new GitHubSetupService(f.home, identity, {
		...f.options,
		env: { PATH: process.env.PATH, GH_TOKEN: "remote-existing-secret" },
	});
	const state = await service.act(action("authorize"));
	assert.match(state.problem!, /environment override/);
	assert.equal(
		f.calls.some((c) => c.args.includes("--with-token")),
		false,
	);
	const verified = await service.act(action("verify"));
	assert.equal(verified.apiReady, false);
	assert.match(verified.problem!, /environment override/);
	assert.ok(!JSON.stringify(verified).includes("remote-existing-secret"));
});
