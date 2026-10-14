import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { access } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WiFiStatus } from "@pilot/protocol";
import type { WiFiHelperFactory } from "./wifi-detection.ts";

/** LaunchServices gives the helper its own TCC identity, independent of Node and the main app's lifetime. */
export const openWiFiHelper: WiFiHelperFactory = async (onStatus, onClose) => {
	if (process.platform !== "darwin") throw new Error("macOS required");
	const source = dirname(fileURLToPath(import.meta.url));
	const app =
		process.env.PILOT_WIFI_HELPER_APP ??
		(source.includes("/Contents/Resources/runtime/")
			? resolve(source.split("/Contents/Resources/runtime/")[0], "Contents/Helpers/PilotWiFi.app")
			: resolve(source, "../../../apps/macos/build/Pilot.app/Contents/Helpers/PilotWiFi.app"));
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
			let end: number;
			while ((end = buffer.indexOf("\n")) >= 0) {
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
						const status = parseWiFiStatus(JSON.parse(line));
						if (!status) {
							candidate.destroy();
							return;
						}
						onStatus(status);
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
	// Do not exec the helper directly: the Node parent's TCC identity cannot authorize SSID access.
	await new Promise<void>((ok, reject) =>
		execFile(
			"/usr/bin/open",
			["-g", "-j", "-n", app, "--args", String(address.port), token],
			{ timeout: 10_000 },
			(error) => (error ? reject(new Error("Wi-Fi helper launch failed")) : ok()),
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
			reject(new Error("Wi-Fi helper connection timed out"));
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
			socket?.write(JSON.stringify(command) + "\n");
		},
		close,
	};
};

export function parseWiFiStatus(value: unknown): WiFiStatus | undefined {
	if (!value || typeof value !== "object") return;
	const v = value as WiFiStatus;
	const name = (s: unknown) => typeof s === "string" && s.length > 0 && Buffer.byteLength(s) <= 32;
	if (
		!["not_determined", "authorized", "denied", "restricted", "disabled", "unavailable"].includes(v.authorization) ||
		typeof v.available !== "boolean" ||
		!(v.currentNetwork === null || name(v.currentNetwork)) ||
		!Array.isArray(v.knownNetworks) ||
		v.knownNetworks.length > 256 ||
		!v.knownNetworks.every(name)
	)
		return;
	return {
		authorization: v.authorization,
		available: v.available,
		currentNetwork: v.authorization === "authorized" && v.available ? v.currentNetwork : null,
		knownNetworks: v.authorization === "authorized" ? [...new Set(v.knownNetworks)] : [],
		...(v.error ? { error: "Wi-Fi monitoring unavailable." } : {}),
	};
}
