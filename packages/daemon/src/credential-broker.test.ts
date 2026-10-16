import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, type OAuthCredential } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CredentialClient, credentialEnvironment } from "@pilot/kernel/credential-client";
import { CredentialChannel } from "@pilot/kernel/credential-rpc";
import { NativeAdapter } from "../../kernel/src/native-adapter.ts";
import { ownModelCatalog } from "../../kernel/src/model-catalog-owner.ts";
import { CredentialBroker } from "./credential-broker.ts";
import { workerProbe } from "./mcp-status.ts";
import { approve, oauthFixture } from "./mcp-test-fixtures.ts";
import { PiSourceMcpClient } from "./source-mcp.ts";

const credential = (access = "old", refresh = "rotate-0"): OAuthCredential => ({
	type: "oauth",
	access,
	refresh,
	expires: 0,
});
function journalBarrier(
	dir: string,
	predicate: (state: Record<string, { generation: number; revoked?: boolean }>) => boolean,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let done = false;
		const close = (error?: Error) => {
			if (done) return;
			done = true;
			watcher.close();
			clearTimeout(timer);
			error ? reject(error) : resolve();
		};
		const check = async () => {
			try {
				if (predicate(JSON.parse(await readFile(join(dir, ".pilot-credential-journal.json"), "utf8")))) close();
			} catch {
				close(new Error("Journal read failed"));
			}
		};
		const watcher = watch(dir, (_, file) => {
			if (file === ".pilot-credential-journal.json") void check();
		});
		const timer = setTimeout(() => close(new Error("Credential fence was not committed")), 5000);
		void check();
	});
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pilot-credential-test-")));
	const dir = join(root, "agent");
	await mkdir(dir, { mode: 0o700 });
	await writeFile(join(dir, "auth.json"), JSON.stringify({ fixture: credential() }), { mode: 0o600 });
	const broker = new CredentialBroker(dir);
	await broker.start();
	const admin = new CredentialClient(broker.grant(true)),
		client = new CredentialClient(broker.grant());
	t.after(async () => {
		await admin.close();
		await client.close();
		await broker.close();
		await rm(root, { recursive: true, force: true });
	});
	return { root, dir, broker, admin, client };
}

test("overlapping native model availability refreshes do not exhaust the credential queue", async (t) => {
	const { client } = await fixture(t);
	const runtime = await ModelRuntime.create({ credentials: client.pi, modelsPath: null, allowModelNetwork: false });
	ownModelCatalog(runtime);
	const expected = runtime.getAvailableSnapshot();
	const available = await Promise.all(Array.from({ length: 8 }, () => runtime.getAvailable()));
	for (const models of available) assert.deepEqual(models, expected);
});

test("actual Pi OAuth double-checks latest canonical tokens and exchanges one rotating grant across concurrent consumers", async (t) => {
	const { dir, client, broker } = await fixture(t);
	let refreshes = 0;
	let dropReply = false;
	const valid = new Set(["rotate-0"]);
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const part of req) body += part;
		const refresh = new URLSearchParams(body).get("refresh_token")!;
		refreshes++;
		if (!valid.delete(refresh)) {
			res.writeHead(400);
			res.end('{"error":"invalid_grant"}');
			return;
		}
		const rotated = `rotate-${refreshes}`;
		valid.add(rotated);
		if (dropReply) {
			req.socket.destroy();
			return;
		}
		res.end(JSON.stringify(credential(`access-${refreshes}`, rotated)));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const models = (client: CredentialClient) => {
		const models = createModels({ credentials: client.pi });
		models.setProvider({
			...fauxProvider().provider,
			id: "fixture",
			auth: {
				oauth: {
					name: "Rotating fixture",
					login: async () => credential(),
					refresh: async (current, signal) => {
						const response = await fetch(url, {
							method: "POST",
							body: new URLSearchParams({ refresh_token: current.refresh }),
							signal,
						});
						assert.equal(response.status, 200);
						return { ...((await response.json()) as OAuthCredential), expires: Date.now() + 3_600_000 };
					},
					toAuth: async (value) => ({ apiKey: value.access }),
				},
			},
		});
		return models;
	};
	const other = new CredentialClient(broker.grant());
	t.after(() => other.close());
	const a = models(client),
		b = models(other);
	const result = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? a : b).getAuth("fixture")));
	assert.equal(refreshes, 1);
	assert.ok(result.every((auth) => auth?.auth.apiKey === "access-1"));
	assert.equal(JSON.parse(await readFile(join(dir, "auth.json"), "utf8")).fixture.refresh, "rotate-1");
	const latest = JSON.parse(await readFile(join(dir, "auth.json"), "utf8"));
	latest.fixture.expires = 0;
	await writeFile(join(dir, "auth.json"), JSON.stringify(latest));
	dropReply = true;
	await assert.rejects(a.getAuth("fixture"));
	await assert.rejects(b.getAuth("fixture"));
	assert.equal(refreshes, 2, "ambiguous external exchanges are never replayed by a second runtime");
});

test("lost exchange/worker and broker restart never replay an uncertain refresh; explicit login replaces the fenced generation", async (t) => {
	const { dir, broker, client } = await fixture(t);
	let exchanges = 0;
	await assert.rejects(
		client.pi.modify("fixture", async () => {
			exchanges++;
			throw new Error("remote may already have rotated; secret must not escape");
		}),
	);
	await assert.rejects(
		client.pi.modify("fixture", async () => {
			exchanges++;
			return credential();
		}),
		/uncertain/,
	);
	assert.equal(exchanges, 1);
	await broker.close();
	await assert.rejects(client.pi.read("fixture"), /unavailable/);
	const restarted = new CredentialBroker(dir);
	await restarted.start();
	t.after(() => restarted.close());
	const next = new CredentialClient(restarted.grant()),
		admin = new CredentialClient(restarted.grant(true));
	t.after(async () => {
		await next.close();
		await admin.close();
	});
	await assert.rejects(
		next.pi.modify("fixture", async () => {
			exchanges++;
			return credential();
		}),
		/uncertain/,
	);
	await admin.transaction("pi", "fixture", "login", async () => {
		await admin.pi.modify("fixture", async () => credential("login", "new-grant"));
	});
	assert.equal(((await next.pi.read("fixture")) as OAuthCredential).refresh, "new-grant");
	assert.equal(exchanges, 1);
});

test("logout and newer login fence in-flight stale commits; external canonical replacements are not overwritten", async (t) => {
	const { dir, client, admin } = await fixture(t);
	let resume!: () => void, started!: () => void;
	const wait = new Promise<void>((resolve) => {
		resume = resolve;
	});
	const entered = new Promise<void>((resolve) => {
		started = resolve;
	});
	const update = client.pi.modify("fixture", async () => {
		started();
		await wait;
		return credential("stale", "stale-grant");
	});
	await entered;
	const fenced = journalBarrier(dir, (state) => state["pi:fixture"]?.revoked === true);
	const logout = admin.pi.delete("fixture");
	// A fence is durable before logout waits for the old refresh's canonical lock.
	await fenced;
	await writeFile(join(dir, "auth.json"), JSON.stringify({ fixture: credential("external-stale") }));
	assert.equal(
		await client.pi.read("fixture"),
		undefined,
		"a revocation intent hides even an intervening external write",
	);
	resume();
	await assert.rejects(update, /stale/);
	await logout;
	assert.equal(await client.pi.read("fixture"), undefined);
	await admin.transaction("pi", "fixture", "login", async () => {
		await admin.pi.modify("fixture", async () => credential("new-login"));
	});
	const stale = new CredentialChannel(client.endpoint);
	await stale.request({ op: "begin", namespace: "pi", key: "fixture", mode: "refresh" });
	const generation = JSON.parse(await readFile(join(dir, ".pilot-credential-journal.json"), "utf8"))["pi:fixture"]
		.generation;
	const newerFence = journalBarrier(dir, (state) => state["pi:fixture"]!.generation > generation);
	const login = admin.transaction("pi", "fixture", "login", async () => {
		await admin.pi.modify("fixture", async () => credential("newest-login"));
	});
	await newerFence;
	await assert.rejects(
		stale.request({ op: "commit", namespace: "pi", key: "fixture", changed: true, value: credential("stale") }),
		/stale/,
	);
	stale.close();
	await login;
	assert.equal(((await client.pi.read("fixture")) as OAuthCredential).access, "newest-login");
	await assert.rejects(
		client.pi.modify("fixture", async () => {
			await writeFile(join(dir, "auth.json"), JSON.stringify({ fixture: credential("external-login") }));
			return credential("stale");
		}),
		/stale/,
	);
	assert.equal(((await client.pi.read("fixture")) as OAuthCredential).access, "external-login");
});

test("capabilities, fixed auth schemas, paths, oversized frames and unavailable brokerage fail closed without secret errors", async (t) => {
	const { root, dir, broker, client } = await fixture(t);
	await assert.rejects(client.request({ op: "read", namespace: "pi", key: "../../settings.json" }), /invalid/);
	await assert.rejects(client.request({ op: "read", namespace: "pi", key: "x".repeat(70_000) }), /invalid/);
	await assert.rejects(client.request({ op: "delete", namespace: "pi", key: "fixture" }), /unauthorized/);
	await assert.rejects(
		client.transaction("pi", "fixture", "login", async () => {}),
		/unauthorized/,
	);
	await assert.rejects(
		client.pi.modify("fixture", async () => ({ type: "api_key", key: "do-not-log-this" })),
		(error: Error) => {
			assert.doesNotMatch(error.message, /do-not-log-this/);
			return true;
		},
	);
	const raw = new CredentialChannel(client.endpoint);
	await assert.rejects(
		raw.request({ op: "read", namespace: "pi", key: "fixture", path: join(dir, "settings.json") } as never),
		/invalid/,
	);
	raw.close();
	const endpoint = broker.grant();
	const revoked = new CredentialClient(endpoint);
	broker.revoke(endpoint);
	await assert.rejects(revoked.pi.read("fixture"), /unauthorized/);
	await client.close();
	await revoked.close();
	const outside = join(root, "outside");
	await writeFile(outside, "protected");
	await broker.close();
	await rm(join(dir, "auth.json"));
	await symlink(outside, join(dir, "auth.json"));
	const unsafe = new CredentialBroker(dir);
	await assert.rejects(unsafe.start());
	assert.equal(await readFile(outside, "utf8"), "protected");
});

test("real MCP sign-in/status/source workers share one canonical rotating grant through the broker", {
	timeout: 90_000,
}, async (t) => {
	const { dir, broker } = await fixture(t);
	const endpoint = broker.grant(true);
	const old = credentialEnvironment();
	for (const key of Object.keys(old)) old[key] = process.env[key];
	Object.assign(process.env, credentialEnvironment(endpoint));
	const server = await oauthFixture();
	server.state.rotatingRefresh = true;
	const source = new PiSourceMcpClient(dir, { openUrl: approve });
	t.after(async () => {
		await source.close();
		await server.close();
		for (const [key, value] of Object.entries(old)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	await writeFile(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { linear: { url: server.url } } }));
	const signal = new AbortController().signal;
	await source.signIn("linear", { again: false, signal });
	const key = `mcp__linear|${server.url}`;
	const values = JSON.parse(await readFile(join(dir, "mcp-auth.json"), "utf8"));
	values[key].tokensExpireAt = 0;
	await writeFile(join(dir, "mcp-auth.json"), JSON.stringify(values));
	const results = await Promise.all(Array.from({ length: 2 }, () => source.call("linear", "issues", {}, signal)));
	assert.ok(results.every((value: unknown) => (value as { token: string }).token === "token-2"));
	assert.equal(server.grants.filter((grant) => grant === "refresh_token").length, 1);
	const status = await workerProbe(dir)({ signal });
	assert.ok("servers" in status && status.servers.some((server) => server.state === "connected"));
	const expired = JSON.parse(await readFile(join(dir, "mcp-auth.json"), "utf8"));
	expired[key].tokensExpireAt = 0;
	await writeFile(join(dir, "mcp-auth.json"), JSON.stringify(expired));
	server.state.dropRefreshReply = true;
	await assert.rejects(source.call("linear", "issues", {}, signal));
	await assert.rejects(source.call("linear", "issues", {}, signal));
	assert.equal(
		server.grants.filter((grant) => grant === "refresh_token").length,
		2,
		"a lost MCP refresh response is not replayed",
	);
	server.state.dropRefreshReply = false;
	await source.signIn("linear", { again: true, signal });
	assert.equal(JSON.parse(await readFile(join(dir, "mcp-auth.json"), "utf8"))[key].tokens.access_token, "token-4");
});

test("legacy MCP grants are claimed once and a tombstone prevents legacy resurrection", async (t) => {
	const { dir, client, admin } = await fixture(t);
	const url = "https://example.invalid/mcp";
	const state = {
		serverUrl: url,
		tokens: { access_token: "legacy", refresh_token: "legacy-refresh", token_type: "Bearer" },
	};
	await writeFile(join(dir, "mcp-auth.json"), JSON.stringify({ [url]: state }));
	const a = client.mcpKey("a", url),
		b = client.mcpKey("b", url);
	assert.deepEqual(await client.request({ op: "peek", namespace: "mcp", key: a }), state);
	assert.ok(Object.hasOwn(JSON.parse(await readFile(join(dir, "mcp-auth.json"), "utf8")), url));
	assert.deepEqual(await client.request({ op: "read", namespace: "mcp", key: a }), state);
	assert.equal(await client.request({ op: "read", namespace: "mcp", key: b }), undefined);
	await admin.request({ op: "delete", namespace: "mcp", key: a });
	await writeFile(join(dir, "mcp-auth.json"), JSON.stringify({ [url]: state }));
	assert.equal(await client.request({ op: "read", namespace: "mcp", key: a }), undefined);
});

test("native parent runtime retains provider registration with canonical broker credentials", {
	timeout: 20_000,
}, async (t) => {
	const { root, dir, broker } = await fixture(t);
	await writeFile(join(dir, "auth.json"), JSON.stringify({ faux: credential() }));
	await writeFile(
		join(dir, "fixture.ts"),
		`
import {fauxProvider} from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/faux"))};
export default pi=>{const faux=fauxProvider();for(let i=0;i<12;i++)pi.registerProvider({...faux.provider,id:'catalog-'+i,getModels:()=>[]});pi.registerProvider({...faux.provider,auth:{oauth:{name:'Fixture',login:async()=>{throw Error('no login')},refresh:async current=>({...current,expires:Date.now()+3600000}),toAuth:async current=>({apiKey:current.access})}}});};`,
	);
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({
			extensions: [join(dir, "second-loader.ts"), join(dir, "fixture.ts")],
			defaultProvider: "faux",
			defaultModel: "faux-1",
		}),
	);
	// The immutable child profile loads this through Jiti after native ESM installed it.
	await writeFile(
		join(dir, "second-loader.ts"),
		`import {installCredentialBrokerHooks} from ${JSON.stringify(new URL("../../kernel/src/credential-hooks.ts", import.meta.url).href)};export default async()=>{await installCredentialBrokerHooks()};`,
	);
	const old = credentialEnvironment();
	for (const key of Object.keys(old)) old[key] = process.env[key];
	old.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
	old.PI_OFFLINE = process.env.PI_OFFLINE;
	old.NODE_OPTIONS = process.env.NODE_OPTIONS;
	old.PILOT_READ_ONLY_CONFIG = process.env.PILOT_READ_ONLY_CONFIG;
	process.env.PI_CODING_AGENT_DIR = dir;
	process.env.PI_OFFLINE = "1";
	process.env.PILOT_READ_ONLY_CONFIG = "1";
	Object.assign(process.env, credentialEnvironment(broker.grant()));
	let adapter: NativeAdapter | undefined;
	try {
		adapter = await NativeAdapter.open({
			cwd: root,
			agentDir: dir,
			sessionFile: join(root, "parent.jsonl"),
			projectTrusted: false,
			model: "faux/faux-1",
		});
		assert.equal(adapter.model.provider, "faux");
	} finally {
		await adapter?.close();
		for (const [key, value] of Object.entries(old)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("SIGKILL of the real authority preserves the uncertainty fence after stale SDK locks recover", {
	skip: process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true",
	timeout: 90_000,
}, async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pilot-broker-crash-")));
	const agent = join(root, "agent");
	await mkdir(agent, { mode: 0o700 });
	await writeFile(join(agent, "auth.json"), JSON.stringify({ fixture: credential() }), { mode: 0o600 });
	const entry = join(root, "authority.mjs");
	await writeFile(
		entry,
		`import {CredentialBroker} from ${JSON.stringify(new URL("./credential-broker.ts", import.meta.url).href)};
const broker=new CredentialBroker(${JSON.stringify(agent)});await broker.start();process.send(broker.grant());`,
	);
	const child = fork(entry, [], { execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] });
	t.after(async () => {
		child.kill("SIGKILL");
		await rm(root, { recursive: true, force: true });
	});
	const [endpoint] = await once(child, "message");
	const channel = new CredentialChannel(endpoint);
	await channel.request({ op: "begin", namespace: "pi", key: "fixture", mode: "refresh" });
	const exit = once(child, "exit");
	child.kill("SIGKILL");
	await exit;
	channel.close();
	const restarted = new CredentialBroker(agent);
	await restarted.start();
	const client = new CredentialClient(restarted.grant());
	try {
		let exchanges = 0;
		await assert.rejects(
			client.pi.modify("fixture", async () => {
				exchanges++;
				return credential("unsafe-retry");
			}),
			/uncertain/,
		);
		assert.equal(exchanges, 0);
	} finally {
		await client.close();
		await restarted.close();
	}
});
