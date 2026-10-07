import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_PORT } from "@pilot/protocol";

export interface DaemonConfig {
	home: string;
	host: string;
	port: number;
	agentDir?: string;
	/** Close idle, unwatched session kernels after this many milliseconds. */
	idleParkMs?: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
	const dataHome = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
	const port = Number(env.PILOT_PORT ?? DEFAULT_PORT);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid PILOT_PORT: ${env.PILOT_PORT}`);
	const idleParkMs = env.PILOT_IDLE_PARK_MS === undefined ? undefined : Number(env.PILOT_IDLE_PARK_MS);
	if (idleParkMs !== undefined && !(idleParkMs > 0))
		throw new Error(`Invalid PILOT_IDLE_PARK_MS: ${env.PILOT_IDLE_PARK_MS}`);
	return {
		home: resolve(env.PILOT_HOME || join(dataHome, "pilot")),
		// Loopback only until the daemon has authentication.
		host: "127.0.0.1",
		port,
		agentDir: env.PILOT_AGENT_DIR || undefined,
		...(idleParkMs !== undefined ? { idleParkMs } : {}),
	};
}
