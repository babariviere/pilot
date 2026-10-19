/**
 * Agent access to user-configured Postgres databases. pilotd alone reads the config and opens connections; kernels
 * only see environment names. Grants live in session metadata and last for the session.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import type { ProjectDatabaseSettings } from "@pilot/protocol";
import pg from "pg";
import Cursor from "pg-cursor";
import { getPilotConfigDir } from "./config.ts";

export const DATABASE_CONFIG_FILE = "database.json";
export const DATABASE_MODES = ["read", "write"] as const;
export type DatabaseMode = (typeof DATABASE_MODES)[number];
export type DatabaseAccessPolicy = "allow" | "ask";

export interface DatabaseGrant {
	env: string;
	mode: DatabaseMode;
}

/**
 * A pending "ask" request. Only the app's decision for this id grants it (see decideDatabaseRequest); messages
 * never do.
 */
export interface DatabaseRequest extends DatabaseGrant {
	id: string;
}

/** Persisted per session. */
export interface DatabaseState {
	grants?: DatabaseGrant[];
	request?: DatabaseRequest;
}

interface Target {
	url: string;
	access: DatabaseAccessPolicy;
}
/** Environments of one project. */
export type DatabaseConfig = Map<string, Partial<Record<DatabaseMode, Target>>>;
/** Environments by project folder (see projectKey). */
export type DatabaseProjects = Map<string, DatabaseConfig>;

export interface DatabaseStatement {
	sql: string;
	params: JsonValue[];
}

export interface StatementResult {
	columns: string[];
	rows: Record<string, unknown>[];
	/** Null when rows were cut off before the statement finished. */
	rowCount: number | null;
	truncated: boolean;
}

export type QueryRunner = (
	target: { url: string; mode: DatabaseMode; applicationName: string },
	statements: DatabaseStatement[],
	maxRows: number,
) => Promise<StatementResult[]>;

export const DATABASE_LIMITS = {
	configBytes: 64 * 1024,
	sqlChars: 100_000,
	params: 1_000,
	statements: 20,
	defaultRows: 100,
	maxRows: 1_000,
	resultBytes: 256 * 1024,
	valueChars: 16 * 1024,
	statementTimeoutMs: 30_000,
	lockTimeoutMs: 5_000,
	connectTimeoutMs: 10_000,
	/** Below the kernel's 60 s daemon-call timeout, so the agent never sees a timeout for a committed write. */
	deadlineMs: 50_000,
	concurrent: 4,
};

const ENV_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Project folders as configured, with `~/` expanded and no trailing slash. */
export function projectKey(path: string, home = homedir()): string {
	return resolve(path.startsWith("~/") ? join(home, path.slice(2)) : path);
}

function parseEnvironments(project: string, value: unknown): DatabaseConfig {
	if (!record(value)) throw new Error(`Project ${project} must contain an "environments" object`);
	const config: DatabaseConfig = new Map();
	for (const [name, entry] of Object.entries(value)) {
		if (!ENV_NAME.test(name))
			throw new Error(`Invalid database environment name ${JSON.stringify(name.slice(0, 64))}`);
		if (!record(entry)) throw new Error(`Database environment ${name} must be an object`);
		const modes: Partial<Record<DatabaseMode, Target>> = {};
		for (const [mode, target] of Object.entries(entry)) {
			if (mode !== "read" && mode !== "write")
				throw new Error(`Database environment ${name} has unknown mode ${JSON.stringify(mode.slice(0, 32))}`);
			if (!record(target) || typeof target.url !== "string" || !/^postgres(ql)?:\/\//.test(target.url))
				throw new Error(`Database environment ${name}.${mode} needs a postgres:// url`);
			const access = target.access ?? "ask";
			if (access !== "allow" && access !== "ask")
				throw new Error(`Database environment ${name}.${mode} access must be "allow" or "ask"`);
			modes[mode] = { url: target.url, access };
		}
		if (!modes.read && !modes.write) throw new Error(`Database environment ${name} has no read or write connection`);
		config.set(name, modes);
	}
	return config;
}

/** Validates the config: environments per project folder. Errors name the field, never a URL. */
export function parseDatabaseConfig(value: unknown, home = homedir()): DatabaseProjects {
	if (!record(value) || !record(value.projects))
		throw new Error(`${DATABASE_CONFIG_FILE} must contain a "projects" object keyed by project folder`);
	const projects: DatabaseProjects = new Map();
	for (const [path, project] of Object.entries(value.projects)) {
		if (!path.startsWith("/") && !path.startsWith("~/"))
			throw new Error(
				`Database project ${JSON.stringify(path.slice(0, 200))} must be an absolute folder or start with ~/`,
			);
		if (!record(project)) throw new Error(`Project ${path} must be an object`);
		projects.set(projectKey(path, home), parseEnvironments(path, project.environments));
	}
	return projects;
}

/** Read afresh on every call, so edits apply without restarting pilotd. Undefined when the file is missing. */
export async function loadDatabaseConfig(configDir = getPilotConfigDir()): Promise<DatabaseProjects | undefined> {
	const path = join(configDir, DATABASE_CONFIG_FILE);
	let file: Awaited<ReturnType<typeof open>> | undefined;
	try {
		file = await open(path, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Could not open ${DATABASE_CONFIG_FILE}`);
	}
	try {
		const info = await file.stat();
		if (process.platform !== "win32" && info.mode & 0o077)
			throw new Error(`${DATABASE_CONFIG_FILE} holds credentials and must be readable only by you (chmod 600)`);
		const buffer = Buffer.alloc(DATABASE_LIMITS.configBytes + 1);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		if (bytesRead > DATABASE_LIMITS.configBytes) throw new Error(`${DATABASE_CONFIG_FILE} is larger than 64 KiB`);
		let parsed: unknown;
		try {
			parsed = JSON.parse(buffer.toString("utf8", 0, bytesRead));
		} catch {
			throw new Error(`${DATABASE_CONFIG_FILE} is not valid JSON`);
		}
		return parseDatabaseConfig(parsed);
	} finally {
		await file.close();
	}
}

/** Safe to return through the settings API, unlike raw filesystem/parser errors. */
export class DatabaseSettingsError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

async function settingsFile(configDir: string) {
	let file: Awaited<ReturnType<typeof open>>;
	try {
		file = await open(
			join(configDir, DATABASE_CONFIG_FILE),
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { revision: "missing", raw: { projects: {} } as Record<string, unknown> };
		throw new DatabaseSettingsError(422, "Cannot read database settings. Check the file and its permissions.");
	}
	try {
		const info = await file.stat();
		if (!info.isFile() || (process.platform !== "win32" && info.mode & 0o077))
			throw new DatabaseSettingsError(422, "Database settings must be a regular, owner-only file (chmod 600).");
		if (info.size > DATABASE_LIMITS.configBytes) throw new Error("size");
		const buffer = Buffer.alloc(DATABASE_LIMITS.configBytes + 1);
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
			if (!chunk.bytesRead) break;
			bytesRead += chunk.bytesRead;
		}
		if (bytesRead > DATABASE_LIMITS.configBytes) throw new Error("size");
		const bytes = buffer.subarray(0, bytesRead);
		const raw: unknown = JSON.parse(bytes.toString("utf8"));
		parseDatabaseConfig(raw);
		return { revision: createHash("sha256").update(bytes).digest("hex"), raw: raw as Record<string, unknown> };
	} catch (error) {
		if (error instanceof DatabaseSettingsError) throw error;
		throw new DatabaseSettingsError(
			422,
			"Database settings are invalid or exceed 64 KiB. Fix the file before editing.",
		);
	} finally {
		await file.close();
	}
}

function existingProject(raw: Record<string, unknown>, path: string) {
	const projects = raw.projects as Record<string, Record<string, unknown>>;
	const keys = Object.keys(projects).filter((key) => projectKey(key) === projectKey(path));
	if (keys.length > 1)
		throw new DatabaseSettingsError(
			422,
			"Multiple database project keys refer to this folder. Remove the duplicate before editing.",
		);
	return { projects, key: keys[0] ?? path, project: keys[0] ? projects[keys[0]]! : { environments: {} } };
}

function connectionSummary(url: string) {
	try {
		const parsed = new URL(url);
		// Omit ALL query parameters, not just a credential-name denylist.
		return {
			scheme: parsed.protocol.slice(0, -1),
			host: parsed.hostname,
			port: parsed.port,
			database: decodeURIComponent(parsed.pathname.slice(1)),
			user: decodeURIComponent(parsed.username),
			hasCredentials: !!parsed.password || !!parsed.search,
		};
	} catch {
		throw new DatabaseSettingsError(422, "A database connection URL cannot be edited. Fix it in the settings file.");
	}
}

function settingsView(raw: Record<string, unknown>, path: string, revision: string): ProjectDatabaseSettings {
	const { project } = existingProject(raw, path);
	const config = parseEnvironments(path, project.environments);
	return {
		revision,
		environments: [...config].map(([name, modes]) => ({
			name,
			...Object.fromEntries(
				DATABASE_MODES.flatMap((mode) => {
					const target = modes[mode];
					return target ? [[mode, { ...connectionSummary(target.url), access: target.access }]] : [];
				}),
			),
		})),
	};
}

function granted(state: DatabaseState | undefined, env: string, mode: DatabaseMode): boolean {
	// Write access is the broader grant: it covers read-mode queries too.
	return !!state?.grants?.some((grant) => grant.env === env && (grant.mode === mode || grant.mode === "write"));
}

function withGrant(state: DatabaseState | undefined, env: string, mode: DatabaseMode): DatabaseState {
	const grants = (state?.grants ?? []).filter((grant) => !(grant.env === env && grant.mode === mode));
	grants.push({ env, mode });
	const request =
		state?.request && !(state.request.env === env && state.request.mode === mode) ? state.request : undefined;
	return { grants, ...(request ? { request } : {}) };
}

/**
 * Applies the app's decision on the pending request with this id. Throws when that request is no longer pending,
 * so a stale or repeated click changes nothing.
 */
export function decideDatabaseRequest(state: DatabaseState | undefined, id: string, allow: boolean): DatabaseState {
	const request = state?.request;
	if (!request || request.id !== id) throw new Error("This database access request is no longer pending");
	return allow ? withGrant(state, request.env, request.mode) : withoutRequest(state);
}

/** Any message while a request is pending declines it: the agent moves on. Undefined when nothing is pending. */
export function declineDatabaseRequest(state: DatabaseState | undefined): DatabaseState | undefined {
	return state?.request ? withoutRequest(state) : undefined;
}

function withoutRequest(state: DatabaseState | undefined): DatabaseState {
	return { ...(state?.grants?.length ? { grants: state.grants } : {}) };
}

export interface DatabaseStateStore {
	read(): DatabaseState | undefined;
	write(state: DatabaseState): Promise<void>;
}

function text(value: unknown, field: string, max: number): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`db ${field} is required`);
	if (value.length > max) throw new Error(`db ${field} is longer than ${max} characters`);
	return value;
}

function parameters(value: unknown): JsonValue[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("db params must be a list");
	if (value.length > DATABASE_LIMITS.params)
		throw new Error(`db params allow at most ${DATABASE_LIMITS.params} values`);
	return value as JsonValue[];
}

export class DatabaseService {
	readonly #configDir: string;
	readonly #run: QueryRunner;
	#active = 0;
	#settingsSaving = false;
	readonly #waiting: (() => void)[] = [];
	/** Configured project folders, cached for synchronous worker specs and refreshed before each kernel start. */
	#projects = new Set<string>();

	constructor(configDir = getPilotConfigDir(), run: QueryRunner = runPostgres) {
		this.#configDir = configDir;
		this.#run = run;
	}

	async settings(path: string): Promise<ProjectDatabaseSettings> {
		const { raw, revision } = await settingsFile(this.#configDir);
		return settingsView(raw, path, revision);
	}

	async updateSettings(path: string, input: unknown): Promise<ProjectDatabaseSettings> {
		if (this.#settingsSaving)
			throw new DatabaseSettingsError(409, "Database settings are being saved. Reload and try again.");
		this.#settingsSaving = true;
		const temp = join(this.#configDir, `.${DATABASE_CONFIG_FILE}.${randomUUID()}.tmp`);
		try {
			const { raw, revision } = await settingsFile(this.#configDir);
			const { projects, key, project } = existingProject(raw, path);
			if (!record(input) || typeof input.revision !== "string" || !Array.isArray(input.environments))
				throw new DatabaseSettingsError(400, "Database settings need a revision and environments list.");
			if (input.revision !== revision)
				throw new DatabaseSettingsError(409, "Database settings changed on disk. Reload before saving.");
			const previous = project.environments as Record<string, Record<string, Record<string, unknown>>>;
			const environments: Record<string, unknown> = Object.create(null);
			for (const entry of input.environments) {
				if (
					!record(entry) ||
					typeof entry.name !== "string" ||
					!ENV_NAME.test(entry.name) ||
					Object.hasOwn(environments, entry.name)
				)
					throw new DatabaseSettingsError(
						400,
						"Environment names must be unique, 1–64 letters, digits, dots, underscores or hyphens, starting with a letter or digit.",
					);
				if (Object.keys(entry).some((key) => !["name", "read", "write"].includes(key)))
					throw new DatabaseSettingsError(400, "Only read and write database modes are supported.");
				const modes: Record<string, unknown> = Object.create(null);
				for (const mode of DATABASE_MODES) {
					if (!Object.hasOwn(entry, mode)) continue;
					const target = entry[mode];
					if (!record(target) || Object.keys(target).some((key) => !["url", "access"].includes(key)))
						throw new DatabaseSettingsError(400, "Each connection accepts only URL and access policy.");
					const old = previous[entry.name]?.[mode];
					const url = target.url === undefined ? old?.url : target.url;
					if (typeof url !== "string" || !/^postgres(ql)?:\/\//.test(url))
						throw new DatabaseSettingsError(400, "Each new connection needs a postgres:// or postgresql:// URL.");
					try {
						connectionSummary(url);
					} catch {
						throw new DatabaseSettingsError(400, "A connection URL is invalid.");
					}
					if (target.access !== undefined && target.access !== "ask" && target.access !== "allow")
						throw new DatabaseSettingsError(400, "Connection access must be ask or allow.");
					modes[mode] = { ...old, url, ...(target.access === undefined ? {} : { access: target.access }) };
				}
				if (!Object.keys(modes).length)
					throw new DatabaseSettingsError(400, "Each environment needs a read or write connection.");
				environments[entry.name] = modes;
			}
			projects[key] = { ...project, environments };
			const bytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`);
			if (bytes.length > DATABASE_LIMITS.configBytes)
				throw new DatabaseSettingsError(400, "Database settings exceed 64 KiB.");
			const result = settingsView(raw, path, createHash("sha256").update(bytes).digest("hex"));
			await mkdir(this.#configDir, { recursive: true, mode: 0o700 });
			const file = await open(temp, "wx", 0o600);
			try {
				await file.writeFile(bytes);
				await file.sync();
			} finally {
				await file.close();
			}
			// Recheck after staging, including permissions and validity, before the atomic replacement.
			if ((await settingsFile(this.#configDir)).revision !== revision)
				throw new DatabaseSettingsError(409, "Database settings changed on disk. Reload before saving.");
			const destination = join(this.#configDir, DATABASE_CONFIG_FILE);
			if (revision === "missing") {
				// Exclusive publication: a racing file creation must never be overwritten.
				try {
					await link(temp, destination);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "EEXIST")
						throw new DatabaseSettingsError(409, "Database settings changed on disk. Reload before saving.");
					throw error;
				}
			} else {
				await rename(temp, destination);
			}
			const directory = await open(this.#configDir, "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
			await this.refresh();
			return result;
		} catch (error) {
			if (error instanceof DatabaseSettingsError) throw error;
			throw new DatabaseSettingsError(503, "Could not save database settings. Reload to check the current values.");
		} finally {
			await rm(temp, { force: true }).catch(() => {});
			this.#settingsSaving = false;
		}
	}

	/** An unreadable or invalid config exposes no tool. The reason is logged without config values. */
	async refresh(): Promise<void> {
		try {
			this.#projects = new Set((await loadDatabaseConfig(this.#configDir))?.keys());
		} catch (error) {
			this.#projects = new Set();
			console.warn(`pilotd: database access is off: ${error instanceof Error ? error.message : error}`);
		}
	}

	/** Whether chats of the project at this folder get the db tool. */
	configured(projectPath: string | undefined): boolean {
		return !!projectPath && this.#projects.has(projectKey(projectPath));
	}

	async call(
		sessionId: string,
		projectPath: string | undefined,
		action: string,
		args: Record<string, JsonValue>,
		store: DatabaseStateStore,
	): Promise<JsonValue> {
		const config = projectPath
			? (await loadDatabaseConfig(this.#configDir))?.get(projectKey(projectPath))
			: undefined;
		if (!config) throw new Error(`No databases are configured for this project (${DATABASE_CONFIG_FILE})`);
		if (action === "access") return this.#access(config, args, store);
		if (action === "query") return this.#query(sessionId, config, args, store);
		throw new Error('db action must be "access" or "query"');
	}

	async #access(
		config: DatabaseConfig,
		args: Record<string, JsonValue>,
		store: DatabaseStateStore,
	): Promise<JsonValue> {
		const state = store.read();
		if (args.env === undefined) {
			return {
				environments: [...config].map(([name, modes]) => ({
					name,
					modes: Object.fromEntries(
						DATABASE_MODES.flatMap((mode) => (modes[mode] ? [[mode, modes[mode].access]] : [])),
					),
					granted: DATABASE_MODES.filter((mode) => modes[mode] && granted(state, name, mode)),
				})),
			};
		}
		const { env, mode } = this.#target(config, args);
		if (granted(state, env, mode)) return { status: "granted", env, mode };
		if (config.get(env)![mode]!.access === "allow") {
			await store.write(withGrant(store.read(), env, mode));
			return { status: "granted", env, mode };
		}
		const id = randomUUID();
		await store.write({ ...withoutRequest(store.read()), request: { env, mode, id } });
		const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, 600) : "";
		return {
			status: "pending",
			env,
			mode,
			question: {
				question: `Allow ${mode} access to the ${env} database?`,
				...(reason ? { context: reason } : {}),
				options: [
					{
						label: `Allow ${mode} access to ${env}`,
						detail:
							mode === "write"
								? "Reads and writes, for the rest of this chat"
								: "Read-only, for the rest of this chat",
					},
					{ label: "Deny" },
				],
				databaseAccess: { id, env, mode },
			},
		};
	}

	#target(config: DatabaseConfig, args: Record<string, JsonValue>): { env: string; mode: DatabaseMode } {
		const env = text(args.env, "env", 64);
		const mode = args.mode ?? "read";
		if (mode !== "read" && mode !== "write") throw new Error('db mode must be "read" or "write"');
		const modes = config.get(env);
		if (!modes)
			throw new Error(
				`Unknown database environment ${JSON.stringify(env)}. Call db({ action: "access" }) to list them.`,
			);
		if (!modes[mode])
			throw new Error(
				mode === "read" ? `${env} has no read-only connection; use mode "write"` : `${env} does not allow writes`,
			);
		return { env, mode };
	}

	async #query(
		sessionId: string,
		config: DatabaseConfig,
		args: Record<string, JsonValue>,
		store: DatabaseStateStore,
	): Promise<JsonValue> {
		const { env, mode } = this.#target(config, args);
		const target = config.get(env)![mode]!;
		if (!granted(store.read(), env, mode)) {
			if (target.access !== "allow")
				throw new Error(
					`No ${mode} access to ${env} yet. Call db({ action: "access", env: "${env}", mode: "${mode}" }) first.`,
				);
			await store.write(withGrant(store.read(), env, mode));
		}
		let statements: DatabaseStatement[];
		if (args.statements !== undefined) {
			if (args.sql !== undefined) throw new Error("Pass either db sql or statements, not both");
			if (mode !== "write") throw new Error('db statements run in one transaction and need mode "write"');
			if (
				!Array.isArray(args.statements) ||
				!args.statements.length ||
				args.statements.length > DATABASE_LIMITS.statements
			)
				throw new Error(`db statements must list 1 to ${DATABASE_LIMITS.statements} statements`);
			statements = args.statements.map((statement, index) => {
				if (!record(statement)) throw new Error(`db statements[${index}] must be an object`);
				return {
					sql: text(statement.sql, `statements[${index}].sql`, DATABASE_LIMITS.sqlChars),
					params: parameters(statement.params),
				};
			});
		} else {
			statements = [{ sql: text(args.sql, "sql", DATABASE_LIMITS.sqlChars), params: parameters(args.params) }];
		}
		const requested = args.maxRows ?? DATABASE_LIMITS.defaultRows;
		if (typeof requested !== "number" || !Number.isInteger(requested) || requested < 1)
			throw new Error("db maxRows must be a positive integer");
		const maxRows = Math.min(requested, DATABASE_LIMITS.maxRows);
		const results = await this.#limited(() =>
			this.#run({ url: target.url, mode, applicationName: `pilot-${sessionId}` }, statements, maxRows),
		);
		const bounded = boundResults(results);
		return (
			args.statements === undefined ? { env, mode, ...bounded[0] } : { env, mode, results: bounded }
		) as JsonValue;
	}

	async #limited<T>(work: () => Promise<T>): Promise<T> {
		while (this.#active >= DATABASE_LIMITS.concurrent)
			await new Promise<void>((resolve) => this.#waiting.push(resolve));
		this.#active++;
		try {
			return await work();
		} finally {
			this.#active--;
			this.#waiting.shift()?.();
		}
	}
}

/** Shortens long values and stops adding rows once the shared byte budget is spent. */
export function boundResults(results: StatementResult[]): StatementResult[] {
	let budget = DATABASE_LIMITS.resultBytes;
	return results.map((result) => {
		let truncated = result.truncated;
		const rows: Record<string, unknown>[] = [];
		for (const row of result.rows) {
			const bounded: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(row)) {
				if (typeof value === "string" && value.length > DATABASE_LIMITS.valueChars) {
					bounded[key] =
						`${value.slice(0, DATABASE_LIMITS.valueChars)}… [${value.length - DATABASE_LIMITS.valueChars} more characters]`;
					truncated = true;
				} else bounded[key] = value;
			}
			const size = Buffer.byteLength(JSON.stringify(bounded));
			if (size > budget) {
				truncated = true;
				budget = 0;
				break;
			}
			budget -= size;
			rows.push(bounded);
		}
		return { ...result, rows, truncated };
	});
}

// Exact JavaScript types only where they cannot lose precision; everything else stays Postgres text.
const PARSED_TYPES = new Set([16, 21, 23, 26, 114, 700, 701, 3802]);
const types = {
	getTypeParser: ((oid: number, format?: "text" | "binary") =>
		PARSED_TYPES.has(oid)
			? pg.types.getTypeParser(oid, format)
			: (value: string) => value) as typeof pg.types.getTypeParser,
};

function readCursor(
	cursor: Cursor,
	rows: number,
): Promise<{ rows: Record<string, unknown>[]; result: pg.QueryResult }> {
	return new Promise((resolve, reject) => {
		cursor.read(rows, (error, read, result) => (error ? reject(error) : resolve({ rows: read, result })));
	});
}

/**
 * One connection per call, so no session state (SET, roles, temp tables) leaks between calls or chats.
 * Reads run inside BEGIN READ ONLY and are rolled back. Statements use the extended protocol, which rejects
 * several commands in one string, so a read cannot COMMIT its way out of the read-only transaction.
 */
export const runPostgres: QueryRunner = async (target, statements, maxRows) => {
	const client = new pg.Client({
		connectionString: target.url,
		application_name: target.applicationName,
		statement_timeout: DATABASE_LIMITS.statementTimeoutMs,
		lock_timeout: DATABASE_LIMITS.lockTimeoutMs,
		idle_in_transaction_session_timeout: DATABASE_LIMITS.deadlineMs,
		connectionTimeoutMillis: DATABASE_LIMITS.connectTimeoutMs,
		types,
	});
	client.on("error", () => {});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(
				new Error(
					`Database call exceeded ${DATABASE_LIMITS.deadlineMs / 1000} s and was cancelled; uncommitted changes were rolled back`,
				),
			);
			// Dropping the connection rolls back any open transaction on the server.
			void client.end().catch(() => {});
		}, DATABASE_LIMITS.deadlineMs);
		timer.unref();
	});
	const work = async () => {
		await client.connect();
		await client.query(target.mode === "read" ? "BEGIN READ ONLY" : "BEGIN");
		const results: StatementResult[] = [];
		for (const [index, statement] of statements.entries()) {
			const cursor = client.query(new Cursor(statement.sql, statement.params));
			try {
				const { rows, result } = await readCursor(cursor, maxRows + 1);
				const truncated = rows.length > maxRows;
				results.push({
					columns: (result?.fields ?? []).map((field) => field.name),
					rows: rows.slice(0, maxRows),
					rowCount: truncated ? null : (result?.rowCount ?? rows.length),
					truncated,
				});
			} catch (error) {
				if (statements.length > 1 && error instanceof Error)
					error.message = `Statement ${index + 1}: ${error.message}`;
				throw error;
			} finally {
				await cursor.close().catch(() => {});
			}
		}
		await client.query(target.mode === "read" ? "ROLLBACK" : "COMMIT");
		return results;
	};
	try {
		return await Promise.race([work(), deadline]);
	} catch (error) {
		throw databaseError(error);
	} finally {
		clearTimeout(timer);
		await client.end().catch(() => {});
	}
};

/** Keeps Postgres's message and hints. Connection errors never include the configured URL. */
function databaseError(error: unknown): Error {
	if (!(error instanceof Error)) return new Error(String(error));
	const pgError = error as Error & { code?: string; detail?: string; hint?: string; position?: string };
	const parts = [pgError.message];
	if (pgError.code && /^[0-9A-Z]{5}$/.test(pgError.code)) parts[0] += ` (SQLSTATE ${pgError.code})`;
	if (pgError.position) parts.push(`Position: ${pgError.position}`);
	if (pgError.detail) parts.push(`Detail: ${pgError.detail}`);
	if (pgError.hint) parts.push(`Hint: ${pgError.hint}`);
	return new Error(parts.join("\n"));
}
