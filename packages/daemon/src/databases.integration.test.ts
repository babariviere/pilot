import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createSecureContext, TLSSocket } from "node:tls";
import { promisify } from "node:util";
import pg from "pg";
import {
	DATABASE_CONFIG_FILE,
	DatabaseService,
	type DatabaseState,
	type DatabaseStateStore,
	decideDatabaseRequest,
	runPostgres,
} from "./databases.ts";

const exec = promisify(execFile);

/** A real server catches what a fake runner cannot: read-only enforcement, the extended protocol and types. */
function postgresBin(): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(":")) if (dir && existsSync(join(dir, "initdb"))) return dir;
	const debian = "/usr/lib/postgresql";
	if (!existsSync(debian)) return undefined;
	for (const version of readdirSync(debian).sort().reverse())
		if (existsSync(join(debian, version, "bin", "initdb"))) return join(debian, version, "bin");
	return undefined;
}

const bin = postgresBin();
let dir = "";
let url = "";
let tlsUrl = "";
let ca = "";
let expiredCert = "";
let fixtureKey = "";
let server: ReturnType<typeof spawn> | undefined;

before(async () => {
	if (!bin) return;
	dir = await mkdtemp(join(tmpdir(), "pilot-pg-"));
	const data = join(dir, "data");
	// Postgres refuses to start with an unset or invalid locale (macOS reports it as "multithreaded during startup").
	const env = { ...process.env, LC_ALL: "C", LANG: "C" };
	await exec(
		join(bin, "initdb"),
		["-D", data, "-U", "pilot", "--auth=trust", "--no-sync", "--no-locale", "-E", "UTF8"],
		{
			timeout: 60_000,
			env,
		},
	);
	// Entirely disposable server and credentials. TCP requires TLS; the existing tests use its Unix socket.
	const key = join(data, "server.key");
	const cert = join(data, "server.crt");
	await exec(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-days",
			"1",
			"-subj",
			"/CN=localhost",
			"-addext",
			"subjectAltName=DNS:localhost",
			"-keyout",
			key,
			"-out",
			cert,
		],
		{ timeout: 30_000 },
	);
	await chmod(key, 0o600);
	ca = await readFile(cert, "utf8");
	const csr = join(dir, "expired.csr");
	const expired = join(dir, "expired.crt");
	const expiredKey = join(dir, "expired.key");
	await exec("openssl", [
		"req",
		"-new",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-keyout",
		expiredKey,
		"-subj",
		"/CN=localhost",
		"-out",
		csr,
	]);
	// Explicit past dates work across OpenSSL versions without sleeps or wall-clock changes.
	const caConfig = join(dir, "ca.cnf");
	await writeFile(join(dir, "index"), "");
	await writeFile(join(dir, "serial"), "02\n");
	await writeFile(
		caConfig,
		[
			"[ca]",
			"default_ca=fixture",
			"[fixture]",
			`database=${join(dir, "index")}`,
			`serial=${join(dir, "serial")}`,
			`new_certs_dir=${dir}`,
			`certificate=${cert}`,
			`private_key=${key}`,
			"default_md=sha256",
			"policy=subject",
			"[subject]",
			"commonName=supplied",
			"",
		].join("\n"),
	);
	await exec("openssl", [
		"ca",
		"-batch",
		"-notext",
		"-config",
		caConfig,
		"-in",
		csr,
		"-startdate",
		"20000101000000Z",
		"-enddate",
		"20010101000000Z",
		"-out",
		expired,
	]);
	fixtureKey = await readFile(expiredKey, "utf8");
	expiredCert = await readFile(expired, "utf8");
	await writeFile(
		join(data, "pg_hba.conf"),
		[
			"local all all trust",
			"hostnossl all all 127.0.0.1/32 reject",
			"hostssl all denied_fixture 127.0.0.1/32 reject",
			"hostssl all password_fixture 127.0.0.1/32 scram-sha-256",
			"hostssl all all 127.0.0.1/32 trust",
			"",
		].join("\n"),
	);
	const port = String(20_000 + Math.floor(Math.random() * 20_000));
	server = spawn(
		join(bin, "postgres"),
		["-D", data, "-k", dir, "-p", port, "-c", "listen_addresses=127.0.0.1", "-c", "ssl=on", "-c", "fsync=off"],
		{ stdio: "ignore", env },
	);
	url = `postgres://pilot@/postgres?host=${encodeURIComponent(dir)}&port=${port}`;
	tlsUrl = `postgres://pilot@localhost:${port}/postgres`;
	for (let attempt = 0; ; attempt++) {
		try {
			await runPostgres({ url, mode: "read", applicationName: "pilot-test" }, [{ sql: "select 1", params: [] }], 1);
			break;
		} catch (error) {
			if (attempt > 100) throw error;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
});

after(async () => {
	server?.kill("SIGINT");
	if (server && server.exitCode === null) await new Promise((resolve) => server!.once("exit", resolve));
	if (dir) await rm(dir, { recursive: true, force: true });
});

const read = (sql: string, params: unknown[] = [], maxRows = 100) =>
	runPostgres({ url, mode: "read", applicationName: "pilot-test" }, [{ sql, params: params as never }], maxRows);
const write = (statements: Array<{ sql: string; params?: unknown[] }>) =>
	runPostgres(
		{ url, mode: "write", applicationName: "pilot-test" },
		statements.map((statement) => ({ sql: statement.sql, params: (statement.params ?? []) as never })),
		100,
	);

test("writes commit as one transaction and report row counts", { skip: !bin && "no Postgres binaries" }, async () => {
	const results = await write([
		{ sql: "create table items (id int primary key, name text)" },
		{ sql: "insert into items values ($1, $2), ($3, $4) returning id", params: [1, "a", 2, "b"] },
		{ sql: "update items set name = 'c' where id = 1" },
	]);
	assert.deepEqual(results[1]?.rows, [{ id: 1 }, { id: 2 }]);
	assert.equal(results[2]?.rowCount, 1);
	await assert.rejects(
		write([{ sql: "insert into items values (3, 'x')" }, { sql: "insert into items values (1, 'dup')" }]),
		/Statement 2: duplicate key value.*SQLSTATE 23505/s,
	);
	assert.deepEqual((await read("select count(*)::int as n from items"))[0]?.rows, [{ n: 2 }]);
	await write([{ sql: "create sequence should_not_run" }]);
	// Sequence increments are not rolled back, so this detects later execution even if the transaction aborts.
	await assert.rejects(
		write([{ sql: "select 1 / 0" }, { sql: "select nextval('should_not_run')" }]),
		/Statement 1:.*SQLSTATE 22012/,
	);
	assert.deepEqual((await read("select is_called from should_not_run"))[0]?.rows, [{ is_called: false }]);
});

test("TLS-required connections retain object CA, verify certificates, and enforce read-only transactions", {
	skip: !bin && "no Postgres binaries",
}, async () => {
	const run = (
		connection: string,
		ssl?: Parameters<typeof runPostgres>[0]["ssl"],
		sql = "select ssl from pg_stat_ssl where pid = pg_backend_pid()",
	) =>
		runPostgres({ url: connection, ssl, mode: "read", applicationName: "pilot-tls-test" }, [{ sql, params: [] }], 1);
	const secured = `${tlsUrl}?sslmode=verify-full`;
	assert.deepEqual((await run(secured, { ca }))[0]?.rows, [{ ssl: true }]);
	assert.deepEqual((await run(secured, { ca }, "show transaction_read_only"))[0]?.rows, [
		{ transaction_read_only: "on" },
	]);
	await assert.rejects(
		run(secured, { ca }, "create table forbidden_tls_write (n int)"),
		/read-only transaction.*SQLSTATE 25006/,
	);
	await assert.rejects(run(secured), /TLS certificate verification failed/);
	await assert.rejects(run(secured.replace("localhost", "127.0.0.1"), { ca }), /TLS certificate verification failed/);
	await assert.rejects(run(`${tlsUrl}?sslmode=no-verify`, true), /TLS certificate verification failed/);
	await assert.rejects(
		run(`${tlsUrl.replace("localhost", "127.0.0.1")}?sslmode=require&uselibpqcompat=true`, { ca }),
		/TLS certificate verification failed/,
	);
	await assert.rejects(
		run(`${tlsUrl}?sslmode=disable`),
		// A plaintext HBA rejection is not proof that TLS would grant access.
		/SQLSTATE 28000.*server authentication rules.*unencrypted connection.*does not establish a TLS requirement/,
	);
});

test("saved project TLS reaches the real driver, while discovery and approval never open a connection", {
	skip: !bin && "no Postgres binaries",
}, async (t) => {
	const configDir = await mkdtemp(join(tmpdir(), "pilot-pg-config-"));
	t.after(() => rm(configDir, { recursive: true, force: true }));
	const project = join(configDir, "project");
	const service = new DatabaseService(configDir);
	const connect = t.mock.method(pg.Client.prototype, "connect");
	let state: DatabaseState | undefined;
	const store: DatabaseStateStore = {
		read: () => state,
		write: async (value) => {
			state = value;
		},
	};
	const update = async (connection: string) => {
		const settings = await service.settings(project);
		await service.updateSettings(project, {
			revision: settings.revision,
			environments: [{ name: "prod", read: { url: connection } }],
		});
	};
	// An operator-provided CA in database.json must survive editing and URL parsing all the way to pg.
	await writeFile(
		join(configDir, DATABASE_CONFIG_FILE),
		JSON.stringify({
			projects: {
				[project]: {
					environments: {
						prod: {
							read: {
								url: `${tlsUrl}?sslmode=verify-full`,
								ssl: { ca },
								access: "ask",
							},
						},
					},
				},
			},
		}),
		{ mode: 0o600 },
	);
	await update(`${tlsUrl}?sslmode=verify-full`);
	await service.refresh();
	assert.equal(service.configured(project), true);
	const settings = await service.settings(project);
	assert.doesNotMatch(JSON.stringify(settings), /BEGIN CERTIFICATE|postgres:\/\/|sslmode/);
	const call = (action: string, args: Parameters<DatabaseService["call"]>[3]) =>
		service.call("offline-tls-fixture", project, action, args, store);
	// Target a closed port: these operations must still work without testing connectivity.
	await update("postgres://pilot@127.0.0.1:1/postgres?sslmode=verify-full");
	assert.deepEqual(await call("access", {}), {
		environments: [{ name: "prod", modes: { read: "ask" }, granted: [] }],
	});
	const pending = await call("access", { env: "prod" });
	assert.equal((pending as { status: string }).status, "pending");
	await store.write(decideDatabaseRequest(state, state!.request!.id, true));
	const approved = structuredClone(state);
	assert.deepEqual(await call("access", { env: "prod" }), { status: "granted", env: "prod", mode: "read" });
	assert.equal(connect.mock.callCount(), 0, "saving, discovery and approval do not test connectivity");
	await assert.rejects(call("query", { env: "prod", sql: "select 1" }), /Database connection failed/);
	assert.equal(connect.mock.callCount(), 1, "no retry on connection rejection");
	assert.deepEqual(state, approved);
	await update(`${tlsUrl.replace("localhost", "127.0.0.1")}?sslmode=verify-full`);
	await assert.rejects(call("query", { env: "prod", sql: "select 1" }), /TLS certificate verification failed/);
	assert.equal(connect.mock.callCount(), 2, "hostname verification fails without a fallback connection");
	assert.deepEqual(state, approved);
	// Only an explicit query against the disposable server demonstrates verified TLS and read-only mode.
	await update(`${tlsUrl}?sslmode=verify-full`);
	assert.deepEqual(
		await call("query", {
			env: "prod",
			sql: "select ssl, current_setting('transaction_read_only') as read_only from pg_stat_ssl where pid = pg_backend_pid()",
		}),
		{
			env: "prod",
			mode: "read",
			columns: ["ssl", "read_only"],
			rows: [{ ssl: true, read_only: "on" }],
			rowCount: 1,
			truncated: false,
		},
	);
	await assert.rejects(
		call("query", { env: "prod", sql: "create table forbidden_config_write (n int)" }),
		/SQLSTATE 25006/,
	);
	assert.equal(connect.mock.callCount(), 4, "one connection per explicit fixture query");
	assert.deepEqual(state, approved);
});

test("real password and server-rule failures preserve SQLSTATE without exposing server details", {
	skip: !bin && "no Postgres binaries",
}, async () => {
	await write([
		{ sql: "create role password_fixture login password 'synthetic-password'" },
		{ sql: "create role denied_fixture login" },
	]);
	const run = (user: string, password: string) =>
		runPostgres(
			{
				url: `${tlsUrl.replace("pilot@", `${user}:${password}@`)}?sslmode=verify-full`,
				ssl: { ca },
				mode: "read",
				applicationName: "pilot-auth-test",
			},
			[{ sql: "select ssl from pg_stat_ssl where pid = pg_backend_pid()", params: [] }],
			1,
		);
	assert.deepEqual((await run("password_fixture", "synthetic-password"))[0]?.rows, [{ ssl: true }]);
	for (const [user, code, expected] of [
		["password_fixture", "28P01", /rejected the credentials \(invalid password\)/],
		["denied_fixture", "28000", /server authentication rules rejected/],
		["missing_fixture", "28000", /cause is undetermined/],
	] as const) {
		await assert.rejects(run(user, "incorrect-password"), (error: NodeJS.ErrnoException) => {
			assert.equal(error.code, code);
			assert.match(error.message, new RegExp(`SQLSTATE ${code}`));
			assert.match(error.message, expected);
			assert.match(error.message, /access approval does not verify connectivity/);
			assert.doesNotMatch(error.message, /fixture|password@|incorrect-password|localhost|postgres:\/\//);
			assert.doesNotMatch(error.message, /explicitly requires TLS|TLS certificate verification failed/);
			return true;
		});
	}
});

test("an expired trusted certificate stops TLS before PostgreSQL startup, without fallback or retry", {
	skip: !bin && "no Postgres binaries",
}, async (t) => {
	const certificate = new X509Certificate(expiredCert);
	assert.ok(certificate.verify(new X509Certificate(ca).publicKey));
	assert.ok(Date.parse(certificate.validTo) < Date.now());
	const context = createSecureContext({ cert: expiredCert, key: fixtureKey });
	const sockets = new Set<Socket>();
	let connections = 0;
	const requests: Buffer[] = [];
	const startup: Buffer[] = [];
	const server = createServer((socket) => {
		connections++;
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => socket.destroy());
		let request = Buffer.alloc(0);
		const negotiate = (bytes: Buffer) => {
			request = Buffer.concat([request, bytes]);
			if (request.length < 8) return;
			requests.push(request);
			socket.off("data", negotiate);
			socket.write("S");
			const tls = new TLSSocket(socket, { isServer: true, secureContext: context });
			tls.on("error", () => tls.destroy());
			tls.on("data", (bytes) => startup.push(bytes));
		};
		socket.on("data", negotiate);
	});
	t.after(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	await assert.rejects(
		runPostgres(
			{
				url: `postgres://fixture:synthetic-password@localhost:${(server.address() as AddressInfo).port}/postgres?sslmode=verify-full`,
				ssl: { ca },
				mode: "read",
				applicationName: "pilot-expiry-test",
			},
			[{ sql: "select 1", params: [] }],
			1,
		),
		(error: Error) => {
			assert.match(error.message, /TLS certificate verification failed/);
			assert.doesNotMatch(error.message, /fixture|synthetic-password|localhost|BEGIN CERTIFICATE/);
			return true;
		},
	);
	assert.equal(connections, 1);
	assert.equal(Buffer.concat(requests).toString("hex"), "0000000804d2162f");
	assert.equal(Buffer.concat(startup).length, 0, "no PostgreSQL startup, credentials or queries after invalid TLS");
});

test("reads cannot write, even with a role that could", { skip: !bin && "no Postgres binaries" }, async () => {
	await assert.rejects(read("insert into items values (9, 'x')"), /read-only transaction.*SQLSTATE 25006/s);
	await assert.rejects(read("create temp table t (x int)"), /read-only transaction/);
	// The extended protocol refuses several commands, so a read cannot commit and continue outside the transaction.
	await assert.rejects(read("commit; insert into items values (9, 'x')"), /multiple commands/);
	await assert.rejects(read("select set_config('transaction_read_only', 'off', true)"), /read-write mode/);
	assert.deepEqual((await read("select count(*)::int as n from items"))[0]?.rows, [{ n: 2 }]);
});

test("reads keep lossless types and cap rows", { skip: !bin && "no Postgres binaries" }, async () => {
	const [typed] = await read(
		"select $1::int as i, 9007199254740993::bigint as big, 1.10::numeric as num, true as ok, '{\"a\":1}'::jsonb as doc, '2026-01-02T03:04:05Z'::timestamptz at time zone 'UTC' as at",
		[7],
	);
	assert.deepEqual(typed?.columns, ["i", "big", "num", "ok", "doc", "at"]);
	assert.deepEqual(typed?.rows, [
		{ i: 7, big: "9007199254740993", num: "1.10", ok: true, doc: { a: 1 }, at: "2026-01-02 03:04:05" },
	]);

	const [capped] = await read("select generate_series(1, 10) as n", [], 3);
	assert.deepEqual(capped?.rows, [{ n: 1 }, { n: 2 }, { n: 3 }]);
	assert.equal(capped?.truncated, true);
	assert.equal(capped?.rowCount, null);
	const [whole] = await read("select generate_series(1, 3) as n", [], 3);
	assert.equal(whole?.truncated, false);
	assert.equal(whole?.rowCount, 3);
});

test("connection failures do not echo the URL", { skip: !bin && "no Postgres binaries" }, async () => {
	const secretUrl = `postgres://pilot:hunter2@/postgres?host=${encodeURIComponent(join(dir, "missing"))}&port=1`;
	await assert.rejects(
		runPostgres(
			{ url: secretUrl, mode: "read", applicationName: "pilot-test" },
			[{ sql: "select 1", params: [] }],
			1,
		),
		(error: Error) => !error.message.includes("hunter2"),
	);
});
