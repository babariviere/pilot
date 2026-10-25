/** Process-lifetime profile lease and read-only boot attestation. Never a host-action grant. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, request, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DaemonHello } from "@pilot/protocol";

export interface RuntimeBuild {
	schema: 1;
	source: string;
	version: string;
	protocol: number;
	platform: string;
	arch: string;
	node: string;
}
export const OWNER_FILE = ".daemon-owner.sqlite";
const RECORD = ".daemon-owner.json";
const ROUTE = "/__pilot_runtime/v1?challenge=";
const CAP = 16_384;
export class RuntimeFailure extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(reason);
		this.reason = reason;
	}
}
function fail(reason: string): never {
	throw new RuntimeFailure(reason);
}
const homeHash = (home: string) => createHash("sha256").update(home).digest("hex");
const mac = (secret: string, body: string) =>
	createHmac("sha256", Buffer.from(secret, "hex")).update(body).digest("hex");

function privateFile(path: string, cap: number): number {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const s = fstatSync(fd);
		if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0 || s.size > cap || s.nlink !== 1)
			fail("runtime_owner_unsafe");
		return fd;
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}
function readPrivate(path: string, cap: number): string {
	const fd = privateFile(path, cap);
	try {
		const buffer = Buffer.alloc(cap + 1);
		let bytes = 0;
		while (true) {
			const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
			if (count === 0) break;
			bytes += count;
			if (bytes > cap) fail("runtime_owner_unsafe");
		}
		return buffer.toString("utf8", 0, bytes);
	} finally {
		closeSync(fd);
	}
}
async function profile(home: string): Promise<string> {
	const s = lstatSync(home);
	if (!s.isDirectory() || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0) fail("runtime_profile_unsafe");
	return realpath(home);
}

function openLease(home: string): DatabaseSync {
	const path = join(home, OWNER_FILE);
	// Do not open/close an unrelated fd for this inode: POSIX closing ANY fd can
	// release this process's SQLite locks. SQLite owns all lease descriptors.
	const before = lstatSync(path);
	if (
		!before.isFile() ||
		before.uid !== process.getuid?.() ||
		(before.mode & 0o077) !== 0 ||
		before.nlink !== 1 ||
		before.size > 1_048_576
	)
		fail("runtime_owner_unsafe");
	const db = new DatabaseSync(path, { timeout: 0 });
	const after = lstatSync(path);
	if (before.ino !== after.ino || before.dev !== after.dev || !after.isFile()) {
		db.close();
		fail("runtime_owner_changed");
	}
	return db;
}
function managed(db: DatabaseSync): boolean {
	if (db.prepare("PRAGMA user_version").get()?.user_version !== 1) fail("runtime_profile_unproven");
	const row = db.prepare("SELECT managed FROM runtime_owner WHERE singleton = 1").get();
	if (!row || (row.managed !== 0 && row.managed !== 1)) fail("runtime_profile_unproven");
	return row.managed === 1;
}
function busy(error: unknown): boolean {
	return (error as { errcode?: number })?.errcode === 5;
}

export interface RuntimeOwner {
	server: Server;
	install(handler: RequestListener): void;
	ready(hello: DaemonHello): void;
	close(): Promise<void>;
}

/** Runs before importing the service graph. A legacy profile is never enrolled by a bundled launch. */
export async function ownRuntime(
	home: string,
	port: number,
	bundled: boolean,
	build: RuntimeBuild | null,
): Promise<RuntimeOwner> {
	let fresh = false;
	await mkdir(dirname(resolve(home)), { recursive: true, mode: 0o700 });
	try {
		await mkdir(home, { mode: 0o700 });
		fresh = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	home = await profile(home);
	const path = join(home, OWNER_FILE);
	let created = false;
	try {
		lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		if (bundled && !fresh) fail("runtime_profile_unproven");
		const fd = openSync(
			path,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		closeSync(fd);
		created = true;
	}
	const db = openLease(home);
	try {
		try {
			db.exec("BEGIN EXCLUSIVE");
		} catch (error) {
			if (busy(error)) fail("runtime_profile_owned");
			throw error;
		}
		if (created) {
			db.exec(
				`CREATE TABLE runtime_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1), managed INTEGER NOT NULL); INSERT INTO runtime_owner VALUES(1,${bundled && fresh ? 1 : 0}); PRAGMA user_version=1; COMMIT; BEGIN EXCLUSIVE;`,
			);
		}
		if (bundled && !managed(db)) fail("runtime_profile_unproven");
		if (!bundled) managed(db);
	} catch (error) {
		db.close();
		throw error;
	}
	const secret = randomBytes(32).toString("hex"),
		boot = randomBytes(32).toString("hex");
	const record = { schema: 1, boot, secret, home: homeHash(home), port, pid: process.pid, build };
	let hello: DaemonHello | undefined;
	let handler: RequestListener | undefined;
	const server = createServer({ requestTimeout: 2000, headersTimeout: 2000 }, (req, res) => {
		if (req.url?.startsWith(ROUTE)) {
			const challenge = req.url.slice(ROUTE.length);
			if (req.method !== "GET" || req.headers.origin || !/^[a-f0-9]{64}$/.test(challenge)) {
				res.writeHead(400).end();
				return;
			}
			const body = JSON.stringify({
				schema: 1,
				boot,
				home: record.home,
				port,
				pid: record.pid,
				build,
				challenge,
				ready: !!hello,
				hello,
			});
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", Connection: "close" });
			res.end(JSON.stringify({ body, mac: mac(secret, body) }));
			return;
		}
		if (hello && handler) handler(req, res);
		else res.writeHead(503, { Connection: "close", "Retry-After": "1" }).end();
	});
	server.maxConnections = 128;
	server.keepAliveTimeout = 1000;
	try {
		await new Promise<void>((ok, reject) => {
			server.once("error", reject);
			server.listen(port, "127.0.0.1", () => {
				server.removeListener("error", reject);
				ok();
			});
		});
		const temp = join(home, `${RECORD}.${boot}.tmp`);
		await writeFile(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
		await rename(temp, join(home, RECORD));
	} catch {
		server.close();
		db.close();
		fail("runtime_listener_unavailable");
	}
	let closed = false;
	return {
		server,
		install(value) {
			handler = value;
		},
		ready(value) {
			// Bootstrap bounds must not shorten ordinary API uploads/streams or cap
			// established chat subscriptions after the service graph is installed.
			server.requestTimeout = 300_000;
			server.headersTimeout = 60_000;
			server.keepAliveTimeout = 5000;
			Reflect.deleteProperty(server, "maxConnections");
			hello = value;
		},
		async close() {
			if (closed) return;
			closed = true;
			hello = undefined;
			server.closeAllConnections();
			await new Promise<void>((ok) => server.close(() => ok()));
			db.close(); // Never unlink the permanent lease inode or signal a PID from a record.
		},
	};
}

/** Pure proof read. No settings, credentials, user agent code, SQLite data or lifecycle mutation. */
export async function inspectRuntime(
	home: string,
	port: number,
	build: RuntimeBuild,
): Promise<"idle" | "starting" | "ready"> {
	home = await profile(home);
	let db: DatabaseSync;
	try {
		db = openLease(home);
	} catch {
		return fail("runtime_profile_unproven");
	}
	try {
		try {
			db.exec("BEGIN EXCLUSIVE");
			return managed(db) ? "idle" : fail("runtime_profile_unproven");
		} catch (error) {
			if (!busy(error)) throw error;
		}
	} finally {
		db.close();
	}
	let record: {
		schema: number;
		boot: string;
		secret: string;
		home: string;
		port: number;
		pid: number;
		build: RuntimeBuild;
	};
	try {
		record = JSON.parse(readPrivate(join(home, RECORD), CAP));
	} catch {
		return fail("runtime_owner_unconfirmed");
	}
	if (
		record.schema !== 1 ||
		!/^[a-f0-9]{64}$/.test(record.boot) ||
		!/^[a-f0-9]{64}$/.test(record.secret) ||
		record.home !== homeHash(home) ||
		record.port !== port ||
		!Number.isSafeInteger(record.pid) ||
		record.pid <= 0 ||
		JSON.stringify(record.build) !== JSON.stringify(build)
	)
		fail("runtime_incompatible");
	const challenge = randomBytes(32).toString("hex");
	const response = await new Promise<string>((ok, reject) => {
		const req = request({ host: "127.0.0.1", port, path: ROUTE + challenge, method: "GET", agent: false }, (res) => {
			let bytes = 0;
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes > CAP) req.destroy(new Error("runtime_probe_invalid"));
				else chunks.push(chunk);
			});
			res.on("error", reject);
			res.on("end", () =>
				res.statusCode === 200
					? ok(Buffer.concat(chunks).toString("utf8"))
					: reject(new Error("runtime_probe_invalid")),
			);
		});
		const timer = setTimeout(() => req.destroy(new Error("runtime_probe_timeout")), 1000);
		req.on("error", reject);
		req.on("close", () => clearTimeout(timer));
		req.end();
	}).catch(() => fail("runtime_owner_unconfirmed"));
	try {
		const envelope = JSON.parse(response);
		if (
			typeof envelope.body !== "string" ||
			typeof envelope.mac !== "string" ||
			!/^[a-f0-9]{64}$/.test(envelope.mac) ||
			!timingSafeEqual(Buffer.from(mac(record.secret, envelope.body), "hex"), Buffer.from(envelope.mac, "hex"))
		)
			fail("runtime_proof_invalid");
		const value = JSON.parse(envelope.body);
		if (
			value.schema !== 1 ||
			value.boot !== record.boot ||
			value.home !== record.home ||
			value.port !== port ||
			value.pid !== record.pid ||
			value.challenge !== challenge ||
			JSON.stringify(value.build) !== JSON.stringify(build)
		)
			fail("runtime_proof_invalid");
		if (value.ready !== true) return "starting";
		if (
			value.hello?.capabilities?.independentExecution !== true ||
			value.hello?.daemonVersion !== build.version ||
			value.hello?.protocolVersion !== build.protocol ||
			!Number.isSafeInteger(value.hello?.minimumClientProtocolVersion) ||
			value.hello.minimumClientProtocolVersion < 1 ||
			value.hello.minimumClientProtocolVersion > build.protocol ||
			value.hello?.platform !== build.platform ||
			value.hello?.arch !== build.arch ||
			value.hello?.daemonId !== readPrivate(join(home, "daemon-id"), 128).trim() ||
			value.hello?.lineageId !== readPrivate(join(home, "storage-lineage"), 128).trim()
		)
			fail("runtime_identity_changed");
		if (JSON.parse(readPrivate(join(home, RECORD), CAP)).boot !== record.boot) fail("runtime_owner_changed");
		const fence = openLease(home);
		try {
			try {
				fence.exec("BEGIN EXCLUSIVE");
			} catch (error) {
				if (busy(error)) return "ready";
				throw error;
			}
			fail("runtime_owner_changed");
		} finally {
			fence.close();
		}
	} catch (error) {
		if (error instanceof RuntimeFailure) throw error;
		return fail("runtime_proof_invalid");
	}
}
