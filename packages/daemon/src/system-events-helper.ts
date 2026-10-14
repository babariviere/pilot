import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { access } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SystemEventsHelperFactory } from "./system-events-detection.ts";
import { parseSystemPowerState } from "./system-power.ts";

/** LaunchServices gives the helper an independent application lifetime from pilotd. */
export const openSystemEventsHelper: SystemEventsHelperFactory = async (onPower, onClose) => {
	if (process.platform !== "darwin") throw new Error("macOS required");
	const source = dirname(fileURLToPath(import.meta.url));
	const app =
		process.env.PILOT_SYSTEM_EVENTS_HELPER_APP ??
		(source.includes("/Contents/Resources/runtime/")
			? resolve(source.split("/Contents/Resources/runtime/")[0], "Contents/Helpers/PilotSystemEvents.app")
			: resolve(source, "../../../apps/macos/build/Pilot.app/Contents/Helpers/PilotSystemEvents.app"));
	await access(app);
	const token = randomBytes(32).toString("hex");
	let socket: Socket | undefined;
	let closed = false;
	const candidates = new Set<Socket>();
	const server = createServer();
	const close = () => {
		if (closed) return;
		closed = true;
		clearTimeout(startup);
		for (const candidate of candidates) candidate.destroy();
		socket?.destroy();
		server.close();
	};
	const fail = () => {
		if (!closed) {
			close();
			onClose();
		}
	};
	const startup = setTimeout(fail, 10_000);
	startup.unref();
	server.on("error", fail);
	server.on("connection", (candidate) => {
		if (socket || candidates.size >= 4) {
			candidate.destroy();
			return;
		}
		candidates.add(candidate);
		candidate.setTimeout(5000, () => candidate.destroy());
		let buffer = "";
		candidate.setEncoding("utf8");
		candidate.on("error", () => {});
		candidate.on("close", () => {
			candidates.delete(candidate);
			if (socket === candidate) fail();
		});
		candidate.on("data", (chunk) => {
			if (socket && socket !== candidate) {
				candidate.destroy();
				return;
			}
			buffer += chunk;
			if (Buffer.byteLength(buffer) > 65_536) {
				candidate.destroy();
				return;
			}
			while (true) {
				const end = buffer.indexOf("\n");
				if (end < 0) break;
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 1);
				try {
					if (!socket) {
						const supplied = Buffer.from(JSON.parse(line).token ?? "");
						if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token))) {
							candidate.destroy();
							return;
						}
						socket = candidate;
						candidate.setTimeout(0);
						clearTimeout(startup);
						for (const other of candidates) if (other !== candidate) other.destroy();
					} else {
						const power = parseSystemPowerState(JSON.parse(line));
						if (!power) {
							candidate.destroy();
							return;
						}
						onPower(power);
					}
				} catch {
					candidate.destroy();
					return;
				}
			}
		});
	});
	await new Promise<void>((ok, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			ok();
		});
	}).catch((error) => {
		close();
		throw error;
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		close();
		throw new Error("Helper listener unavailable");
	}
	// LaunchServices keeps the native monitor in its own process and gives it normal app-bundle identity.
	await new Promise<void>((ok, reject) =>
		execFile(
			"/usr/bin/open",
			["-g", "-j", "-n", app, "--args", String(address.port), token],
			{ timeout: 10_000 },
			(error) => (error ? reject(new Error("System Events helper launch failed")) : ok()),
		),
	).catch((error) => {
		close();
		throw error;
	});
	// Wait for the authenticated connection before commands can be sent.
	await new Promise<void>((ok, reject) => {
		if (socket) {
			ok();
			return;
		}
		const timer = setTimeout(() => {
			close();
			reject(new Error("System Events helper connection timed out"));
		}, 10_000);
		const connected = () => {
			if (socket) {
				clearTimeout(timer);
				server.removeListener("connection", watch);
				ok();
			}
		};
		const watch = (candidate: Socket) => candidate.on("data", connected);
		for (const candidate of candidates) watch(candidate);
		server.on("connection", watch);
	});
	return {
		send: (command) => {
			socket?.write(`${JSON.stringify(command)}\n`);
		},
		close,
	};
};
