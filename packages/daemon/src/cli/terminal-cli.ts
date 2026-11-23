import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { type AgentCli, AgentCliError, type TerminalCliReads } from "./agent-cli.ts";

/** Start only after acquiring the profile lock and loading its saved data. */
export async function openTerminalCli(home: string, cli: AgentCli, reads: TerminalCliReads) {
	const uid = process.getuid?.();
	if (uid === undefined) throw new Error("Terminal CLI needs Unix account permissions");
	const directory = join(home, "cli");
	await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error;
	});
	// Restrict traversal too: some Unix systems don't enforce permissions on the socket itself.
	const info = await lstat(directory);
	if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o777) !== 0o700)
		throw new Error("The Pilot profile's cli directory must be owned by this account with mode 0700");
	const socketPath = join(directory, "s");
	// Never let libuv truncate a pathname to its sockaddr_un limit (104 bytes on macOS).
	if (Buffer.byteLength(socketPath) >= 104) throw new Error("Pilot profile path is too long for the terminal CLI");
	const stale = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
	if (stale) {
		if (!stale.isSocket() || stale.uid !== uid) throw new Error("Unexpected file at the Pilot CLI socket path");
		await unlink(socketPath);
	}
	const server = createServer((req, res) => {
		res.setHeader("cache-control", "no-store");
		res.setHeader("content-type", "application/json");
		const send = (status: number, body: unknown) => {
			if (res.destroyed) return;
			res.statusCode = status;
			res.end(JSON.stringify(body));
		};
		void Promise.resolve()
			.then(() => {
				// This listener serves only the CLI's read allowlist; it cannot dispatch Day operations.
				if (req.headers.origin !== undefined || req.headers.authorization !== undefined)
					throw new AgentCliError(403, "Terminal CLI uses the local account, not network or agent credentials");
				return cli.readTerminal(req.method, new URL(req.url ?? "/", "http://localhost"), reads);
			})
			.then(
				(reply) => send(200, reply),
				(error: unknown) =>
					send(error instanceof AgentCliError ? error.status : 503, {
						error: error instanceof AgentCliError ? error.message : "Pilot CLI could not read the saved data",
					}),
			);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});
	try {
		await chmod(socketPath, 0o600);
	} catch (error) {
		server.close();
		throw error;
	}
	return () => {
		server.close();
		server.closeAllConnections();
	};
}
