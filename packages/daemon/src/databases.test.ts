import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import pg from "pg";
import type Cursor from "pg-cursor";
import {
	boundResults,
	DATABASE_CONFIG_FILE,
	DATABASE_LIMITS,
	DatabaseService,
	type DatabaseState,
	decideDatabaseRequest,
	declineDatabaseRequest,
	loadDatabaseConfig,
	parseDatabaseConfig,
	postgresClientConfig,
	projectKey,
	type QueryRunner,
	runPostgres,
} from "./databases.ts";

const environments = {
	local: {
		read: { url: "postgres://ro@localhost/app", access: "allow" },
		write: { url: "postgres://rw@localhost/app", access: "allow" },
	},
	staging: {
		read: { url: "postgres://ro@staging/app", access: "allow" },
		write: { url: "postgres://rw@staging/app" },
	},
	prod: { read: { url: "postgresql://ro@prod/app", access: "ask" } },
};
const project = "/work/app";
const config = {
	projects: { [project]: { environments }, "~/other": { environments: { local: environments.local } } },
};

test("database reads and settings writes use only database.json in the Pilot config directory", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pilot-config-database-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dir = join(root, "config", "pilot");
	const service = new DatabaseService(dir);
	await service.updateSettings(project, {
		revision: "missing",
		environments: [{ name: "local", read: { url: "postgres://ro@localhost/app" } }],
	});
	const path = join(dir, "database.json");
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.equal((await stat(dir)).mode & 0o777, 0o700);
	assert.equal(service.configured(project), true);
	const legacy = join(root, "agent");
	await mkdir(legacy);
	await writeFile(join(legacy, "pilot-databases.json"), JSON.stringify(config), { mode: 0o600 });
	await rm(path);
	await service.refresh();
	assert.equal(service.configured(project), false, "no fallback to pi configuration");
	await writeFile(path, JSON.stringify(config), { mode: 0o600 });
	assert.ok((await loadDatabaseConfig(dir))?.has(project));
});

test("database settings round-trip preserves secrets, omitted access, unknown fields and other projects", async () => {
	const raw = structuredClone(config) as Record<string, any>;
	raw.extra = { future: true };
	raw.projects[project].future = 7;
	raw.projects[project].environments.staging.write.extra = "keep";
	raw.projects[project].environments.prod.read.url =
		"postgresql://ro:secret@prod:5444/app?password=query-secret&sslkey=key-secret&sslpassword=ssl-secret&future_secret=hidden";
	const f = await fixture(raw);
	try {
		const before = await f.service.settings(project);
		const serialized = JSON.stringify(before);
		for (const secret of ["secret", "sslkey", "password", "hidden", "postgresql://"])
			assert.ok(!serialized.includes(secret));
		assert.deepEqual(before.environments.find((env) => env.name === "prod")?.read, {
			scheme: "postgresql",
			host: "prod",
			port: "5444",
			database: "app",
			user: "ro",
			hasCredentials: true,
			access: "ask",
		});
		const environments = before.environments.map((env) => ({
			name: env.name,
			...(env.read ? { read: {} } : {}),
			...(env.write ? { write: {} } : {}),
		}));
		await f.service.updateSettings(project, { revision: before.revision, environments });
		assert.deepEqual(JSON.parse(await readFile(join(f.dir, DATABASE_CONFIG_FILE), "utf8")), raw);
		assert.equal((await stat(join(f.dir, DATABASE_CONFIG_FILE))).mode & 0o777, 0o600);
		const saved = await f.service.settings(project);
		await f.service.updateSettings(project, {
			revision: saved.revision,
			environments: [{ name: "new", read: { url: "postgres://new@localhost/db" } }],
		});
		const updated = JSON.parse(await readFile(join(f.dir, DATABASE_CONFIG_FILE), "utf8"));
		assert.deepEqual(updated.projects["~/other"], raw.projects["~/other"]);
		assert.equal(updated.projects[project].future, 7);
		assert.equal(updated.projects[project].environments.new.read.access, undefined);
		assert.equal((await f.service.settings(project)).environments[0]?.read?.access, "ask");
		assert.equal(f.service.configured(project), true);
	} finally {
		await rm(f.dir, { recursive: true, force: true });
	}
});

test("database settings never replace invalid, insecure, oversized, stale or duplicate configuration", async () => {
	for (const [value, permissions] of [
		["{ broken secret", 0o600],
		[config, 0o644],
		[" ".repeat(DATABASE_LIMITS.configBytes + 1), 0o600],
	] as const) {
		const f = await fixture(value, permissions);
		try {
			const path = join(f.dir, DATABASE_CONFIG_FILE),
				before = await readFile(path);
			await assert.rejects(f.service.settings(project));
			await assert.rejects(f.service.updateSettings(project, { revision: "missing", environments: [] }));
			assert.deepEqual(await readFile(path), before);
			assert.equal((await stat(path)).mode & 0o777, permissions);
		} finally {
			await rm(f.dir, { recursive: true, force: true });
		}
	}
	const f = await fixture();
	try {
		const before = await f.service.settings(project),
			path = join(f.dir, DATABASE_CONFIG_FILE);
		const changed = `${JSON.stringify(config)}\n`;
		await writeFile(path, changed);
		await assert.rejects(
			f.service.updateSettings(project, { revision: before.revision, environments: [] }),
			/changed on disk/,
		);
		assert.equal(await readFile(path, "utf8"), changed);
		await writeFile(
			path,
			JSON.stringify({ projects: { [project]: { environments }, [`${project}/`]: { environments } } }),
		);
		const duplicate = await readFile(path, "utf8");
		await assert.rejects(f.service.settings(project), /Multiple database project keys/);
		await assert.rejects(
			f.service.updateSettings(project, { revision: before.revision, environments: [] }),
			/Multiple database project keys/,
		);
		assert.equal(await readFile(path, "utf8"), duplicate);
	} finally {
		await rm(f.dir, { recursive: true, force: true });
	}
});

test("database settings create owner-only files and retain the existing normalized project key", async () => {
	const f = await fixture({ projects: { [`${project}/`]: { environments: {} } } });
	try {
		const before = await f.service.settings(project);
		await f.service.updateSettings(project, {
			revision: before.revision,
			environments: [
				{
					name: "local",
					read: { url: "postgres://ro@local/app" },
					write: { url: "postgres://rw@local/app", access: "allow" },
				},
			],
		});
		assert.deepEqual(Object.keys(JSON.parse(await readFile(join(f.dir, DATABASE_CONFIG_FILE), "utf8")).projects), [
			`${project}/`,
		]);
		await rm(join(f.dir, DATABASE_CONFIG_FILE));
		assert.deepEqual(await f.service.settings(project), { revision: "missing", environments: [] });
		await f.service.updateSettings(project, {
			revision: "missing",
			environments: [{ name: "local", read: { url: "postgres://ro@local/app" } }],
		});
		assert.equal((await stat(join(f.dir, DATABASE_CONFIG_FILE))).mode & 0o777, 0o600);
		const current = await f.service.settings(project);
		await assert.rejects(
			f.service.updateSettings(project, { revision: current.revision, environments: [{ name: "bad", read: {} }] }),
			/new connection needs/,
		);
		await assert.rejects(
			f.service.updateSettings(project, {
				revision: current.revision,
				environments: [{ name: "bad", read: { url: "postgres://secret:%invalid@host/app", access: "oops" } }],
			}),
			/invalid|access must/,
		);
		await assert.rejects(
			f.service.updateSettings(project, {
				revision: current.revision,
				environments: [{ name: "local", admin: {} }],
			}),
			/Only read and write/,
		);
	} finally {
		await rm(f.dir, { recursive: true, force: true });
	}
});

test("database settings refuse symbolic links without altering the target", async () => {
	const f = await fixture();
	try {
		const path = join(f.dir, DATABASE_CONFIG_FILE),
			target = join(f.dir, "target.json");
		await writeFile(target, JSON.stringify(config), { mode: 0o600 });
		await rm(path);
		await symlink(target, path);
		await assert.rejects(f.service.settings(project), /Cannot read/);
		await assert.rejects(f.service.updateSettings(project, { revision: "missing", environments: [] }), /Cannot read/);
		assert.deepEqual(JSON.parse(await readFile(target, "utf8")), config);
	} finally {
		await rm(f.dir, { recursive: true, force: true });
	}
});

test("database settings serialize overlapping saves and never repair an unreadable file", async () => {
	await using f = await fixture();
	const before = await f.service.settings(project);
	const outcomes = await Promise.allSettled(
		["first", "second"].map((name) =>
			f.service.updateSettings(project, {
				revision: before.revision,
				environments: [{ name, read: { url: "postgres://ro@host/app" } }],
			}),
		),
	);
	assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
	const failure = outcomes.find((result) => result.status === "rejected");
	assert.equal(failure?.status === "rejected" && failure.reason.status, 409);
	const path = join(f.dir, DATABASE_CONFIG_FILE),
		bytes = await readFile(path);
	await chmod(path, 0o000);
	try {
		await assert.rejects(f.service.settings(project), /Cannot read/);
		await assert.rejects(
			f.service.updateSettings(project, { revision: before.revision, environments: [] }),
			/Cannot read/,
		);
		assert.equal((await stat(path)).mode & 0o777, 0o000);
	} finally {
		await chmod(path, 0o600);
	}
	assert.deepEqual(await readFile(path), bytes);
});

async function fixture(value: unknown = config, mode = 0o600) {
	const dir = await mkdtemp(join(tmpdir(), "pilot-databases-"));
	const path = join(dir, DATABASE_CONFIG_FILE);
	await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
	await chmod(path, mode);
	const calls: Array<{ url: string; mode: string; applicationName: string; sql: string[] }> = [];
	const run: QueryRunner = async (target, statements) => {
		calls.push({ ...target, sql: statements.map((statement) => statement.sql) });
		return statements.map(() => ({ columns: ["n"], rows: [{ n: 1 }], rowCount: 1, truncated: false }));
	};
	let state: DatabaseState | undefined;
	const store = {
		read: () => state,
		write: async (next: DatabaseState) => {
			state = next;
		},
	};
	const service = new DatabaseService(dir, run);
	return {
		dir,
		calls,
		store,
		state: () => state,
		call: (action: string, args: Record<string, never> | Record<string, unknown>) =>
			service.call("session-1", project, action, args as never, store),
		service,
		[Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }),
	};
}

test("config validation names fields, never URLs, and defaults access to ask", () => {
	const parsed = parseDatabaseConfig(config, "/home/me");
	assert.deepEqual([...parsed.keys()], [project, "/home/me/other"]);
	assert.equal(parsed.get(project)?.get("staging")?.write?.access, "ask");
	assert.equal(parsed.get(project)?.get("prod")?.write, undefined);
	const wrap = (value: unknown) => ({ projects: { [project]: { environments: value } } });
	for (const [value, message] of [
		[{ environments }, /"projects" object/],
		[{ projects: { "relative/app": { environments } } }, /absolute folder/],
		[{ projects: { [project]: {} } }, /"environments" object/],
		[wrap({ "bad name": {} }), /environment name/],
		[wrap({ a: {} }), /no read or write/],
		[wrap({ a: { admin: { url: "postgres://x" } } }), /unknown mode/],
		[wrap({ a: { read: { url: "mysql://secret@host" } } }), /a\.read needs a postgres/],
		[wrap({ a: { read: { url: "postgres://x", access: "always" } } }), /allow" or "ask/],
	] as const) {
		assert.throws(
			() => parseDatabaseConfig(value),
			(error: Error) => message.test(error.message) && !error.message.includes("secret"),
		);
	}
});

test("per-environment TLS options reach the runner and survive secret-free settings edits", async () => {
	const raw = structuredClone(config) as Record<string, any>;
	const ssl = { ca: "private-ca-pem", cert: "client-cert-pem", key: "private-key-pem", rejectUnauthorized: true };
	raw.projects[project].environments.prod.read.ssl = ssl;
	await using db = await fixture(raw);
	const settings = await db.service.settings(project);
	assert.doesNotMatch(JSON.stringify(settings), /private-ca|client-cert|private-key/);
	await db.service.updateSettings(project, {
		revision: settings.revision,
		environments: settings.environments.map((env) => ({
			name: env.name,
			...(env.read ? { read: {} } : {}),
			...(env.write ? { write: {} } : {}),
		})),
	});
	assert.deepEqual((await loadDatabaseConfig(db.dir))?.get(project)?.get("prod")?.read?.ssl, ssl);
	await db.store.write({ grants: [{ env: "prod", mode: "read" }] });
	await db.call("query", { env: "prod", sql: "select 1" });
	assert.deepEqual((db.calls.at(-1) as unknown as { ssl: unknown }).ssl, ssl);
	raw.projects[project].environments.prod.read.ssl = true;
	await writeFile(join(db.dir, DATABASE_CONFIG_FILE), JSON.stringify(raw));
	await db.call("query", { env: "prod", sql: "select 1" });
	assert.equal((db.calls.at(-1) as unknown as { ssl: unknown }).ssl, true, "no pool or cache keeps stale TLS options");
	assert.deepEqual(db.state(), { grants: [{ env: "prod", mode: "read" }] });
});

test("TLS configuration validates options without echoing certificate or key values", () => {
	for (const ssl of [
		null,
		"secret-pem",
		{ ca: 123 },
		{ key: "" },
		{ rejectUnauthorized: false },
		{ typo: "secret-pem" },
	]) {
		assert.throws(
			() =>
				parseDatabaseConfig({
					projects: { [project]: { environments: { local: { read: { url: "postgres://host/db", ssl } } } } },
				}),
			(error: Error) => /local.read.ssl/.test(error.message) && !error.message.includes("secret-pem"),
		);
	}
});

const connectionTarget = { url: "postgres://user@localhost/db", mode: "read", applicationName: "pilot-test" } as const;

test("TLS options are resolved once, with object certificate options overriding URL options", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pilot-db-tls-"));
	try {
		const path = join(dir, "ca.pem");
		await writeFile(path, "url-ca-pem");
		const url = `${connectionTarget.url}?sslmode=verify-full&sslrootcert=${encodeURIComponent(path)}`;
		assert.deepEqual({ ...(postgresClientConfig({ ...connectionTarget, url }).ssl as object) }, { ca: "url-ca-pem" });
		const resolved = postgresClientConfig({
			...connectionTarget,
			url,
			ssl: { ca: "object-ca-pem", key: "object-key-pem" },
		});
		assert.equal(
			resolved.connectionString,
			undefined,
			"pg must not reparse the URL and erase the merged TLS options",
		);
		assert.deepEqual(resolved.ssl, { ca: "object-ca-pem", key: "object-key-pem", rejectUnauthorized: true });
		const client = new pg.Client(resolved);
		assert.deepEqual(client.ssl, resolved.ssl);
		const pool = new pg.Pool(resolved);
		assert.deepEqual(new pg.Client(pool.options).ssl, resolved.ssl, "pool-created clients retain resolved TLS");
		await pool.end();
		assert.deepEqual(postgresClientConfig({ ...connectionTarget, url, ssl: true }).ssl, {
			ca: "url-ca-pem",
			rejectUnauthorized: true,
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("TLS requirements cannot silently become plaintext or disable explicit verification", () => {
	for (const ssl of [true, { ca: "ca-pem" }] as const)
		assert.throws(
			() => postgresClientConfig({ ...connectionTarget, url: `${connectionTarget.url}?sslmode=disable`, ssl }),
			/disagree about TLS/,
		);
	assert.throws(
		() =>
			postgresClientConfig({ ...connectionTarget, url: `${connectionTarget.url}?sslmode=verify-full`, ssl: false }),
		/disagree about TLS/,
	);
	assert.equal(postgresClientConfig({ ...connectionTarget, ssl: false }).ssl, false);
	assert.equal(
		postgresClientConfig({ ...connectionTarget, url: `${connectionTarget.url}?sslmode=disable`, ssl: false }).ssl,
		false,
	);
	const resolved = postgresClientConfig({
		...connectionTarget,
		url: `${connectionTarget.url}?sslmode=require&uselibpqcompat=true`,
		ssl: true,
	});
	assert.deepEqual(resolved.ssl, { rejectUnauthorized: true });
	assert.deepEqual(postgresClientConfig({ ...connectionTarget, ssl: {} }).ssl, { rejectUnauthorized: true });
	assert.equal(
		(
			postgresClientConfig({ ...connectionTarget, url: `${connectionTarget.url}?ssl=no-verify` }).ssl as {
				rejectUnauthorized: boolean;
			}
		).rejectUnauthorized,
		false,
	);
	assert.deepEqual(
		postgresClientConfig({ ...connectionTarget, url: `${connectionTarget.url}?ssl=no-verify`, ssl: true }).ssl,
		{ rejectUnauthorized: true },
	);
});

test("URL parsing and certificate-file errors are sanitized before creating a client", () => {
	assert.throws(
		() =>
			postgresClientConfig({
				...connectionTarget,
				url: `${connectionTarget.url}?sslrootcert=/missing/private-ca-pem`,
			}),
		(error: Error) =>
			/connection configuration failed/.test(error.message) && !/private-ca-pem|postgres:/.test(error.message),
	);
});

test("driver TLS environment defaults survive when no per-connection TLS option is present", () => {
	const previous = process.env.PGSSLMODE;
	try {
		process.env.PGSSLMODE = "verify-full";
		assert.equal(new pg.Client(postgresClientConfig(connectionTarget)).ssl, true);
		assert.equal(new pg.Client(postgresClientConfig({ ...connectionTarget, ssl: false })).ssl, false);
		assert.equal(
			new pg.Client(postgresClientConfig({ ...connectionTarget, url: `${connectionTarget.url}?sslmode=disable` }))
				.ssl,
			false,
		);
	} finally {
		if (previous === undefined) delete process.env.PGSSLMODE;
		else process.env.PGSSLMODE = previous;
	}
});

test("a server refusing TLS receives no plaintext startup or retry", async () => {
	let connections = 0;
	const received: Buffer[] = [];
	const server = createServer((socket) => {
		connections++;
		socket.on("error", () => {});
		socket.on("data", (bytes) => {
			received.push(bytes);
			socket.end("N");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const port = (server.address() as AddressInfo).port;
		await assert.rejects(
			runPostgres(
				{ ...connectionTarget, url: `postgres://fixture@127.0.0.1:${port}/db?sslmode=verify-full` },
				[
					{ sql: "select 1", params: [] },
					{ sql: "select * from information_schema.tables", params: [] },
				],
				1,
			),
			/Database connection failed.*access approval does not verify connectivity/,
		);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
	assert.equal(connections, 1);
	assert.equal(
		Buffer.concat(received).toString("hex"),
		"0000000804d2162f",
		"only PostgreSQL's SSLRequest, no startup packet or queries",
	);
});

test("access approval is not a connectivity test and failed queries leave grants intact", async () => {
	await using db = await fixture();
	let attempts = 0;
	const service = new DatabaseService(db.dir, async () => {
		attempts++;
		throw new Error("Database connection failed. Pilot access approval does not verify connectivity.");
	});
	const call = (action: string, args: Record<string, never> | Record<string, unknown>) =>
		service.call("session-1", project, action, args as never, db.store);
	const pending = await call("access", { env: "prod" });
	assert.equal((pending as { status: string }).status, "pending");
	await db.store.write(decideDatabaseRequest(db.state(), db.state()!.request!.id, true));
	assert.deepEqual(await call("access", { env: "prod" }), { status: "granted", env: "prod", mode: "read" });
	assert.equal(attempts, 0);
	await assert.rejects(async () => {
		await call("query", { env: "prod", sql: "select 1" });
		await call("query", { env: "prod", sql: "select * from information_schema.tables" });
	}, /connection failed.*does not verify connectivity/);
	assert.equal(attempts, 1);
	assert.deepEqual(db.state(), { grants: [{ env: "prod", mode: "read" }] });
});

test("a failed cursor stops sequential statements and closes the connection without committing", async (t) => {
	const controls: string[] = [];
	const cursors: Cursor[] = [];
	let closed = 0;
	t.mock.method(pg.Client.prototype, "connect", async () => {});
	const end = t.mock.method(pg.Client.prototype, "end", async () => {});
	t.mock.method(pg.Client.prototype, "query", ((query: string | Cursor) => {
		if (typeof query === "string") {
			controls.push(query);
			return Promise.resolve();
		}
		cursors.push(query);
		return {
			read: (_rows: number, callback: (error: Error) => void) => callback(new Error("first query failed")),
			close: async () => {
				closed++;
			},
		};
	}) as typeof pg.Client.prototype.query);
	await assert.rejects(
		runPostgres(
			{ ...connectionTarget, mode: "write" },
			[
				{ sql: "select 1", params: [] },
				{ sql: "select * from information_schema.tables", params: [] },
			],
			1,
		),
		/Statement 1: first query failed/,
	);
	assert.deepEqual(controls, ["BEGIN"]);
	assert.equal(cursors.length, 1, "no later statement is submitted");
	assert.equal(closed, 1);
	assert.equal(end.mock.callCount(), 1);
});

test("only configured projects get the tool; the config must be owner-only and is optional", async () => {
	await using db = await fixture();
	await db.service.refresh();
	assert.equal(db.service.configured(project), true);
	assert.equal(db.service.configured(`${project}/`), true);
	assert.equal(db.service.configured("/work/elsewhere"), false);
	assert.equal(db.service.configured(undefined), false);
	assert.equal(projectKey("~/other", "/home/me"), "/home/me/other");
	await assert.rejects(
		db.service.call("session-1", "/work/elsewhere", "access", {}, db.store),
		/No databases are configured for this project/,
	);

	await using open = await fixture(config, 0o644);
	await assert.rejects(loadDatabaseConfig(open.dir), /chmod 600/);
	await open.service.refresh();
	assert.equal(open.service.configured(project), false);
	await rm(join(open.dir, DATABASE_CONFIG_FILE));
	assert.equal(await loadDatabaseConfig(open.dir), undefined);
	await assert.rejects(open.call("access", {}), /No databases are configured for this project/);
});

test("access lists environments without URLs", async () => {
	await using db = await fixture();
	const listed = await db.call("access", {});
	assert.deepEqual(listed, {
		environments: [
			{ name: "local", modes: { read: "allow", write: "allow" }, granted: [] },
			{ name: "staging", modes: { read: "allow", write: "ask" }, granted: [] },
			{ name: "prod", modes: { read: "ask" }, granted: [] },
		],
	});
	assert.doesNotMatch(JSON.stringify(listed), /postgres/);
});

test("allow grants at once; ask asks and only a decision for its id grants", async () => {
	await using db = await fixture();
	assert.deepEqual(await db.call("access", { env: "staging" }), { status: "granted", env: "staging", mode: "read" });
	const pending = (await db.call("access", { env: "staging", mode: "write", reason: " Fix a stuck renewal " })) as {
		status: string;
		question: {
			question: string;
			context: string;
			options: { label: string }[];
			databaseAccess: { id: string; env: string; mode: string };
		};
	};
	assert.equal(pending.status, "pending");
	assert.equal(pending.question.context, "Fix a stuck renewal");
	assert.deepEqual(
		pending.question.options.map((option) => option.label),
		["Allow write access to staging", "Deny"],
	);
	const { id } = pending.question.databaseAccess;
	assert.deepEqual(pending.question.databaseAccess, { id, env: "staging", mode: "write" });
	assert.match(id, /^[0-9a-f-]{36}$/);
	await assert.rejects(
		db.call("query", { env: "staging", mode: "write", sql: "update t set x = 1" }),
		/No write access/,
	);

	// Messages only ever decline; denying and stale ids never grant.
	assert.deepEqual(declineDatabaseRequest(db.state()), { grants: [{ env: "staging", mode: "read" }] });
	assert.equal(declineDatabaseRequest({ grants: [] }), undefined);
	assert.deepEqual(decideDatabaseRequest(db.state(), id, false), { grants: [{ env: "staging", mode: "read" }] });
	assert.throws(() => decideDatabaseRequest(db.state(), "other", true), /no longer pending/);
	assert.throws(() => decideDatabaseRequest(declineDatabaseRequest(db.state()), id, true), /no longer pending/);
	await db.store.write(decideDatabaseRequest(db.state(), id, true));
	assert.deepEqual(db.state(), {
		grants: [
			{ env: "staging", mode: "read" },
			{ env: "staging", mode: "write" },
		],
	});
	await db.call("query", { env: "staging", mode: "write", sql: "update t set x = 1" });
	assert.equal(db.calls.at(-1)?.url, "postgres://rw@staging/app");
	assert.equal(db.calls.at(-1)?.applicationName, "pilot-session-1");
});

test("queries check grants, modes and inputs before connecting", async () => {
	await using db = await fixture();
	await assert.rejects(
		db.call("query", { env: "prod", sql: "select 1" }),
		/Call db\(\{ action: "access", env: "prod", mode: "read" \}\) first/,
	);
	await assert.rejects(db.call("query", { env: "prod", mode: "write", sql: "select 1" }), /does not allow writes/);
	await assert.rejects(db.call("query", { env: "nope", sql: "select 1" }), /Unknown database environment/);
	await assert.rejects(db.call("query", { env: "local", sql: " " }), /sql is required/);
	await assert.rejects(db.call("query", { env: "local", statements: [{ sql: "select 1" }] }), /need mode "write"/);
	await assert.rejects(db.call("query", { env: "local", sql: "select 1", maxRows: 0 }), /maxRows/);
	await assert.rejects(db.call("drop", {}), /must be "access" or "query"/);
	assert.equal(db.calls.length, 0);

	// An "allow" environment grants on first use, so the agent may skip access.
	assert.deepEqual(await db.call("query", { env: "local", sql: "select 1" }), {
		env: "local",
		mode: "read",
		columns: ["n"],
		rows: [{ n: 1 }],
		rowCount: 1,
		truncated: false,
	});
	assert.deepEqual(db.state(), { grants: [{ env: "local", mode: "read" }] });
	const batch = (await db.call("query", {
		env: "local",
		mode: "write",
		statements: [{ sql: "insert into t values ($1)", params: [1] }, { sql: "select 1" }],
	})) as { results: unknown[] };
	assert.equal(batch.results.length, 2);
	assert.deepEqual(db.calls.at(-1)?.sql, ["insert into t values ($1)", "select 1"]);
});

test("a write grant also covers read-mode queries", async () => {
	await using db = await fixture();
	await db.store.write({ grants: [{ env: "staging", mode: "write" }] });
	const before = db.calls.length;
	await db.call("query", { env: "staging", sql: "select 1" });
	assert.equal(db.calls.length, before + 1);
	assert.equal(db.calls.at(-1)?.url, "postgres://ro@staging/app");
});

test("results are bounded by value length and a shared byte budget", () => {
	const long = "x".repeat(DATABASE_LIMITS.valueChars + 5);
	const [shortened] = boundResults([{ columns: ["v"], rows: [{ v: long }], rowCount: 1, truncated: false }]);
	assert.equal(shortened?.truncated, true);
	assert.match(String(shortened?.rows[0]?.v), /… \[5 more characters\]$/);

	const row = { v: "y".repeat(DATABASE_LIMITS.valueChars - 100) };
	const many = Array.from({ length: 40 }, () => row);
	const bounded = boundResults([
		{ columns: ["v"], rows: many, rowCount: 40, truncated: false },
		{ columns: ["v"], rows: many, rowCount: 40, truncated: false },
	]);
	assert.ok(bounded[0]!.rows.length < 40);
	assert.equal(bounded[0]!.truncated, true);
	assert.deepEqual(bounded[1]!.rows, []);
	assert.equal(bounded[1]!.truncated, true);
});
