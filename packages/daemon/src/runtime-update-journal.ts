import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { RuntimeProcessIdentity, RuntimeUpdateStatus } from "@pilot/protocol";
import { durableJSON } from "./operation-journal.ts";

export interface RuntimeUpdateJournal extends Omit<RuntimeUpdateStatus, "requestConfirmed"> {
	schema: 1;
	daemonId: string;
	lineageId: string;
	archive: string;
	manifest: string;
	signature: string;
	publicKey: string;
	from: string;
	to: string;
	oldUnit: string;
	newUnit: string;
	process?: RuntimeProcessIdentity;
	invocation?: string;
}
export const fencedPhases = new Set(["draining", "ready", "stopping", "switching", "validating", "needs-repair"]);
export const committedPhases = new Set(["stopping", "switching", "validating", "completed", "needs-repair"]);
export const updatePath = (home: string) => join(home, "runtime-update", "current.json");

/** Refuse link ancestors and foreign/private-state ownership. Never chmod someone else's tree. */
export async function privateUpdateDirectory(path: string): Promise<void> {
	const absolute = resolve(path);
	const parent = dirname(absolute);
	if (parent !== absolute) {
		try {
			await lstat(parent);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await privateUpdateDirectory(parent);
		}
		if ((await realpath(parent)) !== parent) throw new Error("Update paths must not traverse links");
	}
	let created = true;
	await mkdir(absolute, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error;
		created = false;
	});
	const info = await lstat(absolute);
	if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o077)
		throw new Error("Update state must be private and owned by the service user");
	if (created) {
		const directory = await open(parent, "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	}
}
export async function readUpdate(home: string, id?: string): Promise<RuntimeUpdateJournal | undefined> {
	if (id !== undefined && !/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid update identity");
	const file = id ? join(dirname(updatePath(home)), `${id}.json`) : updatePath(home);
	try {
		await privateUpdateDirectory(dirname(file));
		const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		let value: RuntimeUpdateJournal;
		try {
			const info = await handle.stat();
			if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > 128 * 1024)
				throw new Error("Invalid update journal ownership or size");
			value = JSON.parse(await handle.readFile("utf8"));
		} finally {
			await handle.close();
		}
		if (
			value.schema !== 1 ||
			!/^[a-f0-9-]{36}$/.test(value.id) ||
			!Number.isSafeInteger(value.revision) ||
			value.revision < 1 ||
			!["staged", "requested", "waiting", ...fencedPhases, "completed", "cancelled"].includes(value.phase) ||
			!Array.isArray(value.blockers) ||
			value.blockers.length > 1024 ||
			![
				value.daemonId,
				value.lineageId,
				value.version,
				value.from,
				value.to,
				value.oldUnit,
				value.newUnit,
				value.archive,
				value.manifest,
				value.signature,
				value.publicKey,
			].every((v) => typeof v === "string" && v.length > 0)
		)
			throw new Error("Invalid update journal; repair explicitly without clearing ownership");
		if (id && value.id !== id) throw new Error("Update receipt identity changed");
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
export async function writeUpdate(home: string, value: RuntimeUpdateJournal): Promise<void> {
	await privateUpdateDirectory(dirname(updatePath(home)));
	await durableJSON(updatePath(home), value);
}
export function publicUpdate(value: RuntimeUpdateJournal): RuntimeUpdateStatus {
	return {
		id: value.id,
		version: value.version,
		phase: value.phase,
		requestConfirmed: value.phase !== "staged",
		revision: value.revision,
		blockers: value.blockers,
		...(value.detail ? { detail: value.detail } : {}),
	};
}
export async function processIdentity(pid = process.pid, proc = "/proc"): Promise<RuntimeProcessIdentity> {
	if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Unknown service process");
	const bootId = (await readFile(join(proc, "sys/kernel/random/boot_id"), "utf8")).trim();
	const stat = await readFile(join(proc, String(pid), "stat"), "utf8");
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	const start = fields[19]; // field 22, after pid and comm
	if (!/^[a-f0-9-]{36}$/.test(bootId) || !/^\d+$/.test(start)) throw new Error("Unknown process identity");
	return { bootId, pid, start };
}
export const sameProcess = (a: RuntimeProcessIdentity | undefined, b: RuntimeProcessIdentity) =>
	a?.bootId === b.bootId && a.pid === b.pid && a.start === b.start;
