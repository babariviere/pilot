import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { runPostgres } from "./databases.ts";

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
	await writeFile(
		join(data, "pg_hba.conf"),
		"local all all trust\nhostnossl all all 127.0.0.1/32 reject\nhostssl all all 127.0.0.1/32 trust\n",
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
	await assert.rejects(
		run(`${tlsUrl}?sslmode=disable`),
		/Database connection failed.*SQLSTATE 28000.*required TLS.*access approval does not verify connectivity/,
	);
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
