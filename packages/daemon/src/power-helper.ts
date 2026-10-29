import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ServiceUnavailable } from "./errors.ts";

/** Private newline-delimited frames on inherited pipes, not a network service. */
export interface PowerSample {
	available: boolean;
	authorized: boolean;
	connectedToPower: boolean;
	wifiConnected: boolean;
	online: boolean;
	lidClosed: boolean | null;
	sleeping: boolean;
	fullWake: boolean;
	wakeToken: string;
	sleepGeneration: number;
	closedLidActive: boolean;
}
export type PowerCommand =
	| { action: "activity"; awake: boolean; closedLid: boolean }
	| { action: "authorize" }
	| { action: "sleep" }
	| { action: "allowSleep"; generation: number };
export interface PowerHelper {
	request(command: PowerCommand): Promise<void>;
	close(): Promise<void>;
}
export type PowerHelperFactory = (sample: (value: PowerSample) => void, failed: () => void) => Promise<PowerHelper>;

export function parsePowerSample(value: unknown): PowerSample | undefined {
	if (!value || typeof value !== "object") return;
	const v = value as PowerSample & { type: string };
	if (v.type !== "state" || !/^\d+:\d{1,6}$/.test(v.wakeToken)) return;
	if (!Number.isSafeInteger(v.sleepGeneration) || v.sleepGeneration < 0) return;
	for (const key of [
		"available",
		"authorized",
		"connectedToPower",
		"wifiConnected",
		"online",
		"sleeping",
		"fullWake",
		"closedLidActive",
	] as const)
		if (typeof v[key] !== "boolean") return;
	if (v.lidClosed !== null && typeof v.lidClosed !== "boolean") return;
	return v;
}

export function powerHelperPath(): string {
	const source = dirname(fileURLToPath(import.meta.url));
	return (
		process.env.PILOT_POWER_HELPER ??
		(source.includes("/Contents/Resources/runtime/")
			? resolve(source.split("/Contents/Resources/runtime/")[0]!, "Contents/Helpers/PilotPower")
			: developmentPowerHelperPath(resolve(source, "../../..")))
	);
}

/** Prefer the standalone helper; keep the Swift development build during coexistence. */
export function developmentPowerHelperPath(root: string): string {
	for (const profile of ["release", "debug"]) {
		const binary = resolve(root, "apps/power/target", profile, "PilotPower");
		if (existsSync(binary)) return binary;
	}
	return resolve(root, "apps/macos/build/Pilot.app/Contents/Helpers/PilotPower");
}

export const openPowerHelper: PowerHelperFactory = async (sample, failed) => {
	if (process.platform !== "darwin") throw new ServiceUnavailable("Energy management requires macOS");
	const binary = powerHelperPath();
	const child: ChildProcessWithoutNullStreams = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
	let readyResolve!: () => void;
	let readyReject!: (error: Error) => void;
	const ready = new Promise<void>((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;
	});
	const startup = setTimeout(() => lost(), 10_000);
	startup.unref();
	let ended = false;
	let serial = 0;
	let buffer = "";
	const pending = new Map<number, { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
	const lost = () => {
		if (ended) return;
		ended = true;
		clearTimeout(startup);
		readyReject(new ServiceUnavailable("Energy helper failed to initialize"));
		clearInterval(heartbeat);
		for (const p of pending.values()) {
			clearTimeout(p.timer);
			p.reject(new ServiceUnavailable("Energy helper disconnected"));
		}
		pending.clear();
		child.stdin.destroy(); // Guardian restores the override on EOF, even if pilotd crashes.
		if (child.pid && child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
			const forceExit = setTimeout(() => child.kill("SIGKILL"), 5000);
			forceExit.unref();
			child.once("exit", () => clearTimeout(forceExit));
		}
		failed();
	};
	const send = (value: unknown) => {
		if (!ended && !child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + "\n");
	};
	const heartbeat = setInterval(() => send({ action: "heartbeat" }), 5000);
	heartbeat.unref();
	child.once("error", lost);
	child.once("exit", lost);
	child.stdin.on("error", lost);
	child.stderr.resume(); // Never retain subprocess diagnostics or authorization output.
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		if (ended) return;
		buffer += chunk;
		if (Buffer.byteLength(buffer) > 65_536) return lost();
		let end = buffer.indexOf("\n");
		while (end >= 0) {
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			try {
				const value = JSON.parse(line);
				const state = parsePowerSample(value);
				if (state) {
					sample(state);
					if (state.available) {
						clearTimeout(startup);
						readyResolve();
					}
				} else if (Number.isSafeInteger(value.id) && typeof value.ok === "boolean") {
					const p = pending.get(value.id);
					if (!p) continue;
					pending.delete(value.id);
					clearTimeout(p.timer);
					if (value.ok) p.resolve();
					else
						p.reject(
							new ServiceUnavailable(
								"Energy operation failed. Check administrator permission in Energy settings.",
							),
						);
				} else lost();
			} catch {
				lost();
			}
			end = buffer.indexOf("\n");
		}
	});
	await ready;
	const helper: PowerHelper = {
		request(command) {
			if (ended || pending.size >= 8)
				return Promise.reject(new ServiceUnavailable("Energy helper unavailable or busy"));
			return new Promise<void>((resolve, reject) => {
				const id = ++serial;
				const timer = setTimeout(
					() => {
						lost(); // A missing acknowledgement is unsafe, never assume an override was restored.
					},
					command.action === "authorize" ? 120_000 : 25_000,
				);
				pending.set(id, { resolve, reject, timer });
				send({ id, ...command });
			});
		},
		async close() {
			if (ended) return;
			try {
				await this.request({ action: "activity", awake: false, closedLid: false });
				await this.request({ action: "sleep" });
			} finally {
				lost();
			}
		},
	};
	return helper;
};
