/** Fixed GitHub.com onboarding, owned by the host. No shell, Mac credentials or SSH config edits. */
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { GitHubSetupAction, GitHubSetupStatus, OperationHost } from "@pilot/protocol";
import { installGitHubKeyTransport } from "./github-git-transport.ts";
import { durableJSON } from "./operation-journal.ts";
import { RuntimeAdmission } from "./runtime-admission.ts";
import { SetupError } from "./setup.ts";
import { type ProcessOptions, type ProcessResult, subprocesses } from "./subprocess.ts";

type Command = (file: string, args: string[], options: ProcessOptions) => Promise<ProcessResult>;
interface OAuthReply {
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval?: number;
	access_token?: string;
	error?: string;
}
type Options = {
	userHome?: string;
	env?: NodeJS.ProcessEnv;
	command?: Command;
	fetch?: typeof fetch;
	wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};
const UUID = /^[a-f0-9]{8}-[a-f0-9-]{27}$/i;
const ACCOUNT = /^[a-z\d](?:[a-z\d-]{0,38})$/i;
const fail = (message: string): never => {
	throw new SetupError(409, message);
};
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

export class GitHubSetupService extends RuntimeAdmission {
	readonly home: string;
	private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
	private state: GitHubSetupStatus = { phase: "idle", apiReady: false, sshReady: false };
	private completed: string[] = [];
	private capability = "";
	private readonly loaded: Promise<void>;
	private locked = false;
	private authorization?: AbortController;
	private readonly directory: string;
	readonly userHome: string;
	private readonly command: Command;
	private readonly fetcher: typeof fetch;
	private readonly environment: NodeJS.ProcessEnv;
	private readonly transportEnvironment: NodeJS.ProcessEnv;
	private readonly authOverride: boolean;
	constructor(home: string, identity: OperationHost, options: Options = {}) {
		super();
		this.home = home;
		this.wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
		this.directory = join(home, "github-setup");
		this.userHome = options.userHome ?? homedir();
		this.command = options.command ?? ((file, args, opts) => subprocesses.run(file, args, opts));
		this.fetcher = options.fetch ?? fetch;
		// Deliberately exclude token overrides, agent forwarding, askpass, browser and repository overrides.
		const env = options.env ?? process.env;
		this.authOverride = !!(env.GH_TOKEN || env.GITHUB_TOKEN);
		this.transportEnvironment = env;
		this.environment = {
			HOME: this.userHome,
			PATH: env.PATH ?? "/usr/bin:/bin",
			LANG: "C.UTF-8",
			...(env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME } : {}),
			...(env.GH_CONFIG_DIR ? { GH_CONFIG_DIR: env.GH_CONFIG_DIR } : {}),
			GH_PROMPT_DISABLED: "1",
			GIT_TERMINAL_PROMPT: "0",
		};
		this.loaded = this.load(identity);
		void this.loaded.catch(() => {}); // Routes report initialization failure without an unhandled rejection.
	}
	private async load(identity: OperationHost) {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const info = await lstat(this.directory);
		if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077)
			fail("GitHub setup storage must be a private directory.");
		try {
			const saved = JSON.parse(await readFile(join(this.directory, "state.json"), "utf8"));
			this.state = saved.state;
			this.completed = saved.completed;
			delete this.state.challenge;
			this.state.apiReady = false;
			this.state.sshReady = false;
			if (this.state.phase === "authorizing") {
				this.state.phase = "interrupted";
				this.state.problem = "Authorization was interrupted. Check existing login before starting again.";
			}
			if (this.state.phase === "uploading") this.state.phase = "upload_unknown";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		this.capability = randomBytes(32).toString("hex");
		const file = join(this.home, "github-app-capability");
		await writeFile(`${file}.tmp`, JSON.stringify({ ...identity, token: this.capability }), { mode: 0o600 });
		await rename(`${file}.tmp`, file);
		if (this.state.keyId && this.state.publicKey)
			await installGitHubKeyTransport(this.home, this.keyPath, this.transportEnvironment);
	}
	async authenticate(token: unknown): Promise<void> {
		await this.loaded;
		if (typeof token !== "string" || token.length !== 64 || token !== this.capability)
			throw new SetupError(403, "This operation requires the native app's host-authenticated GitHub action.");
	}
	async status(): Promise<GitHubSetupStatus> {
		await this.loaded;
		return structuredClone(this.state);
	}
	async close(): Promise<void> {
		this.freezeAdmissions();
		this.authorization?.abort();
		if (!this.blockers().length) return;
		await new Promise<void>((resolve) => {
			const stop = this.onChange(() => {
				if (!this.blockers().length) {
					stop();
					resolve();
				}
			});
		});
	}
	private async save() {
		const { challenge: _, ...state } = this.state;
		await durableJSON(join(this.directory, "state.json"), { state, completed: this.completed });
	}
	async act(request: GitHubSetupAction): Promise<GitHubSetupStatus> {
		await this.loaded;
		if (
			!request ||
			!UUID.test(request.id) ||
			!["authorize", "prepare_key", "approve_key", "verify", "cancel", "revoke_key"].includes(request.action) ||
			Object.keys(request).some((k) => !["id", "action", "account", "fingerprint"].includes(k))
		)
			throw new SetupError(400, "Invalid GitHub setup action.");
		if (request.action === "cancel") {
			this.authorization?.abort();
			return this.status(); // Cancellation is acknowledged only when the host operation settles.
		}
		if (this.completed.includes(request.id)) return this.status();
		if (this.locked) fail("A GitHub setup operation is still running on this host. Check its state first.");
		const end = this.begin({ kind: "github-setup", id: request.id });
		this.locked = true;
		let background = false;
		try {
			if (this.completed.length >= 512) fail("GitHub setup operation history is full. No old approval is replayed.");
			this.completed.push(request.id);
			this.state.operationId = request.id;
			delete this.state.problem;
			this.state.apiReady = false;
			this.state.sshReady = false;
			await this.save(); // Consume before any external side effect, including exchanges and uploads.
			if (request.action === "authorize") {
				await this.tools();
				if (await this.account().catch(() => undefined))
					fail(
						"This host already has a GitHub login. Verify it instead. Existing credentials will not be replaced.",
					);
				await this.requireNoLogin();
				const controller = new AbortController();
				this.authorization = controller;
				const code = await this.oauth(
					"https://github.com/login/device/code",
					{ client_id: "Iv1.b507a08c87ecfe98", scope: "repo read:org gist write:public_key read:public_key" },
					controller.signal,
				);
				if (
					typeof code.device_code !== "string" ||
					code.device_code.length > 256 ||
					!/^[A-Z0-9-]{4,32}$/.test(code.user_code) ||
					code.verification_uri !== "https://github.com/login/device" ||
					!Number.isFinite(code.expires_in) ||
					code.expires_in <= 0 ||
					code.expires_in > 1800
				)
					fail("GitHub returned an unsupported authorization challenge.");
				this.state.phase = "authorizing";
				this.state.challenge = {
					url: code.verification_uri,
					code: code.user_code,
					expiresAt: Date.now() + Math.min(code.expires_in, 900) * 1000,
				};
				await this.save();
				background = true;
				void this.authorize(code, controller).finally(() => {
					this.locked = false;
					this.authorization = undefined;
					end();
				});
			} else if (request.action === "prepare_key") {
				await this.tools();
				await this.checkAPI();
				await this.prepareKey();
				this.state.phase = "key_ready";
			} else if (request.action === "verify") {
				await this.checkAPI();
				await this.readKey();
				if (this.state.publicKey) await this.reconcileKey();
				await this.verifySSH();
			} else {
				await this.checkAPI();
				await this.readKey();
				if (
					request.account !== this.state.account ||
					request.fingerprint !== this.state.fingerprint ||
					!this.state.publicKey
				)
					fail("Approval does not match this host's current account and dedicated key. Check again.");
				await this.reconcileKey();
				if (request.action === "revoke_key") {
					if (!this.state.keyId)
						fail("This dedicated key's registration could not be confirmed. Nothing was revoked.");
					await this.gh(["api", "--method", "DELETE", `user/keys/${this.state.keyId}`]);
					delete this.state.keyId;
					this.state.sshReady = false;
					this.state.phase = "key_ready";
				} else {
					if (!this.state.keyId) {
						this.state.phase = "uploading";
						await this.save();
						try {
							await this.gh([
								"api",
								"--method",
								"POST",
								"user/keys",
								"-f",
								"title=Pilot devbox",
								"-f",
								`key=${this.state.publicKey}`,
							]);
						} catch {
							this.state.phase = "upload_unknown";
							this.state.problem =
								"Key registration is not confirmed. Check access to reconcile the exact public key before approving again. SSO or account restrictions may require action on GitHub.";
						}
					}
					await this.reconcileKey();
					await this.verifySSH();
				}
			}
		} catch (error) {
			this.state.sshReady = false;
			this.state.problem =
				error instanceof SetupError
					? error.message
					: "GitHub setup could not be confirmed. Check tools, host trust, login and organization/SSO permissions on this host. No credentials or command output are returned.";
		} finally {
			if (!background) {
				this.locked = false;
				await this.save();
				end();
			}
		}
		return this.status();
	}
	private async tools() {
		for (const [file, args] of [
			["gh", ["--version"]],
			["git", ["--version"]],
			["ssh", ["-V"]],
			["ssh-keygen", ["-l", "-f", "/dev/null"]],
		] as const) {
			const result = await this.exec(file, [...args]);
			if (file !== "ssh-keygen" && result.code !== 0)
				fail(
					"GitHub setup requires gh, git, OpenSSH and ssh-keygen on this host. Install missing tools outside Pilot; no privileged packages are installed automatically.",
				);
		}
	}
	async exec(file: string, args: string[], stdin?: string, signal?: AbortSignal): Promise<ProcessResult> {
		const result = await this.command(file, args, {
			cwd: this.userHome,
			env: this.environment,
			...(stdin !== undefined ? { stdin } : {}),
			...(signal ? { signal } : {}),
			timeoutMs: 15_000,
			detached: process.platform !== "win32",
			maxBytes: 128 * 1024,
			maxStderrBytes: 4096,
			overflow: "fail",
		});
		if (result.aborted || result.timedOut || result.overflowed)
			fail("GitHub operation was interrupted or exceeded its bound. Check the host state before retrying.");
		return result;
	}
	async gh(args: string[], stdin?: string, signal?: AbortSignal) {
		const result = await this.exec("gh", args, stdin, signal);
		if (result.code !== 0)
			fail(
				"GitHub CLI access failed on this host. Check login, scopes, SSO restrictions and revocation. Existing authentication is unchanged.",
			);
		return result.stdout.toString("utf8");
	}
	private async account() {
		const value = JSON.parse(await this.gh(["api", "user"]));
		if (!ACCOUNT.test(value.login)) fail("GitHub returned an invalid account identity.");
		return value.login as string;
	}
	private async checkAPI() {
		if (this.authOverride)
			fail(
				"This host's daemon has a GitHub token environment override. Configure it independently or remove the override and restart before using this helper. Stored credentials will not be replaced or mistaken for the active override.",
			);
		this.state.apiReady = false;
		const account = await this.account();
		if (this.state.account && this.state.account !== account) {
			delete this.state.keyId;
			this.state.sshReady = false;
		}
		this.state.account = account;
		this.state.apiReady = true;
	}
	private async requireNoLogin() {
		if (this.authOverride)
			fail(
				"A GitHub token environment override already exists on this host. No browser login will replace it. Configure GitHub independently or remove that override and restart first.",
			);
		const config =
			this.environment.GH_CONFIG_DIR ??
			join(this.environment.XDG_CONFIG_HOME ?? join(this.userHome, ".config"), "gh");
		const hosts = await readFile(join(config, "hosts.yml"), "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return "";
			throw error;
		});
		if (/^github\.com\s*:/m.test(hosts))
			fail(
				"A GitHub.com login already exists on this host, but access was not verified. Repair or remove it outside Pilot, then check again. It will not be overwritten.",
			);
	}
	private async oauth(url: string, body: Record<string, string>, signal: AbortSignal): Promise<OAuthReply> {
		const response = await this.fetcher(url, {
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(body),
			redirect: "error",
			signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
		});
		if (!response.ok || !response.body)
			fail("GitHub browser authorization is unavailable. Nothing will be retried automatically.");
		let raw = "";
		const reader = response.body!.getReader();
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				raw += Buffer.from(value).toString("utf8");
				if (Buffer.byteLength(raw) > 16_384) fail("GitHub authorization response exceeded its bound.");
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
		return JSON.parse(raw);
	}
	private async authorize(code: OAuthReply, controller: AbortController) {
		try {
			let interval = Math.min(30, Math.max(5, Number(code.interval) || 5));
			while (Date.now() < this.state.challenge!.expiresAt) {
				await this.wait(interval * 1000, controller.signal);
				const reply = await this.oauth(
					"https://github.com/login/oauth/access_token",
					{
						client_id: "Iv1.b507a08c87ecfe98",
						device_code: code.device_code,
						grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					},
					controller.signal,
				);
				if (reply.error === "authorization_pending") continue;
				if (reply.error === "slow_down") {
					interval = Math.min(60, interval + 5);
					continue;
				}
				if (typeof reply.access_token !== "string" || !/^[A-Za-z0-9_]{20,256}$/.test(reply.access_token))
					fail("GitHub authorization was denied or expired. Start again explicitly when ready.");
				await this.requireNoLogin();
				if (controller.signal.aborted) throw new Error("cancelled");
				await this.gh(
					["auth", "login", "--hostname", "github.com", "--git-protocol", "ssh", "--with-token"],
					`${reply.access_token}\n`,
					controller.signal,
				);
				await this.checkAPI();
				this.state.phase = "idle";
				return;
			}
			fail("GitHub authorization expired. Start again explicitly.");
		} catch (error) {
			this.state.phase = "interrupted";
			this.state.problem =
				error instanceof SetupError
					? error.message
					: "Authorization stopped or its completion is uncertain. Check existing login before starting again; no exchange is replayed.";
		} finally {
			delete this.state.challenge;
			await this.save();
		}
	}
	get keyPath() {
		return join(this.directory, "ssh", "id_ed25519");
	}
	get sshCommand() {
		return `ssh -i ${quote(this.keyPath)} -o IdentitiesOnly=yes -o IdentityAgent=none -o ForwardAgent=no -o BatchMode=yes -o StrictHostKeyChecking=yes`;
	}
	private async prepareKey() {
		const directory = join(this.directory, "ssh");
		let exists = false;
		try {
			await mkdir(directory, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			exists = true;
		}
		if (!exists) {
			const result = await this.exec("ssh-keygen", [
				"-t",
				"ed25519",
				"-N",
				"",
				"-C",
				"pilot-devbox",
				"-f",
				this.keyPath,
			]);
			if (result.code !== 0)
				fail(
					"Dedicated key generation did not complete. Existing files were kept, not overwritten. Check this host's setup storage.",
				);
		}
		await this.readKey();
		if (!this.state.publicKey)
			fail(
				"The dedicated key is incomplete. Inspect the host's setup storage; no existing key will be overwritten.",
			);
	}
	private async readKey() {
		const directory = await lstat(join(this.directory, "ssh")).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		if (directory && (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077))
			fail("Dedicated key directory has unsafe permissions or type.");
		const info = await lstat(this.keyPath).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		if (!info) {
			delete this.state.publicKey;
			delete this.state.fingerprint;
			delete this.state.keyId;
			this.state.sshReady = false;
			return;
		}
		if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077)
			fail("Dedicated private key has unsafe file permissions or type.");
		const result = await this.exec("ssh-keygen", ["-y", "-P", "", "-f", this.keyPath]);
		const key = result.stdout.toString().trim().split(/\s+/).slice(0, 2).join(" ");
		if (result.code !== 0 || !/^ssh-ed25519 [A-Za-z0-9+/]{68}={0,2}$/.test(key))
			fail("Dedicated key could not be verified. Existing key material is unchanged.");
		this.state.publicKey = key;
		this.state.fingerprint = `SHA256:${createHash("sha256")
			.update(Buffer.from(key.split(" ")[1]!, "base64"))
			.digest("base64")
			.replace(/=+$/, "")}`;
	}
	private async reconcileKey() {
		if (!this.state.publicKey) return;
		for (let page = 1; page <= 10; page++) {
			const keys = JSON.parse(await this.gh(["api", `user/keys?per_page=100&page=${page}`]));
			if (!Array.isArray(keys)) fail("Could not reconcile GitHub key registration.");
			const key = keys.find((k: { key?: unknown; id?: unknown }) => k.key === this.state.publicKey);
			if (key && Number.isSafeInteger(key.id) && key.id > 0) {
				this.state.keyId = key.id;
				this.state.phase = "key_ready";
				return;
			}
			if (keys.length < 100) {
				delete this.state.keyId;
				return;
			}
		}
		fail("GitHub key inventory exceeded the reconciliation limit. Registration is unknown, not absent.");
	}
	private async verifySSH() {
		this.state.sshReady = false;
		if (!this.state.publicKey || !this.state.keyId) return;
		const result = await this.exec("ssh", [
			"-T",
			"-i",
			this.keyPath,
			"-o",
			"IdentitiesOnly=yes",
			"-o",
			"IdentityAgent=none",
			"-o",
			"ForwardAgent=no",
			"-o",
			"BatchMode=yes",
			"-o",
			"StrictHostKeyChecking=yes",
			"-o",
			"ConnectTimeout=10",
			"git@github.com",
		]);
		const match =
			/^Hi ([A-Za-z0-9-]+)! You've successfully authenticated, but GitHub does not provide shell access\./m.exec(
				result.stderr,
			);
		if (result.code !== 1 || match?.[1]?.toLowerCase() !== this.state.account?.toLowerCase())
			fail(
				"GitHub SSH identity was not verified for this account. Check normal host-key trust and authorize the dedicated key for organization SSO. No host check was bypassed.",
			);
		this.state.sshReady = true;
		await installGitHubKeyTransport(this.home, this.keyPath, this.transportEnvironment);
		this.state.phase = "ready";
		delete this.state.problem;
	}
}
