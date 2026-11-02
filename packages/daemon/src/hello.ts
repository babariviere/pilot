import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	DAEMON_PROTOCOL_VERSION,
	type DaemonCapabilities,
	type DaemonHello,
	MINIMUM_CLIENT_PROTOCOL_VERSION,
} from "@pilot/protocol";
import release from "../../../package.json" with { type: "json" };

/** Publish a complete identity atomically. Concurrent starts agree; corruption never silently re-pairs a host. */
export async function daemonIdentity(home: string): Promise<string> {
	return persistentIdentity(home, "daemon-id");
}

export async function daemonLineage(home: string): Promise<string> {
	return persistentIdentity(home, "storage-lineage");
}

async function persistentIdentity(home: string, name: string): Promise<string> {
	await mkdir(home, { recursive: true, mode: 0o700 });
	const file = join(home, name);
	try {
		await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const id = randomUUID();
		const temp = `${file}.${id}.tmp`;
		try {
			await writeFile(temp, `${id}\n`, { mode: 0o600, flag: "wx" });
			try {
				await link(temp, file);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		} finally {
			await unlink(temp).catch(() => {});
		}
	}
	const id = (await readFile(file, "utf8")).trim();
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
		throw new Error("Invalid daemon identity; refusing to replace a paired host's identity");
	return id;
}

/**
 * Environment setup stays off until its user-facing parts ship. PILOT_ENVIRONMENT_SETUP=1 turns it on for
 * development; clients and environment routes both follow the advertised capability.
 */
export function environmentSetupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PILOT_ENVIRONMENT_SETUP === "1";
}

export async function daemonHello(
	home: string,
	capabilities: DaemonCapabilities,
	env: NodeJS.ProcessEnv = process.env,
): Promise<DaemonHello> {
	return {
		daemonId: await daemonIdentity(home),
		lineageId: await daemonLineage(home),
		daemonVersion: release.version,
		protocolVersion: DAEMON_PROTOCOL_VERSION,
		minimumClientProtocolVersion: MINIMUM_CLIENT_PROTOCOL_VERSION,
		platform: process.platform,
		arch: process.arch,
		capabilities: {
			...capabilities,
			workspaceTerminalProtocol: 2,
			usageQueries: 1,
			...(environmentSetupEnabled(env) ? { environmentSetup: 1 as const } : {}),
		},
	};
}
