import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
	projectKey,
	type QueryRunner,
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
