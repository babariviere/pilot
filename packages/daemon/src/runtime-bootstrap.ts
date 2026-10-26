/** Imported before the daemon graph, not from HTTP handlers. */
import { open, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DAEMON_PROTOCOL_VERSION } from "@pilot/protocol";
import release from "../../../package.json" with { type: "json" };
import { loadConfig } from "./config.ts";
import { ownRuntime, type RuntimeBuild, type RuntimeOwner } from "./runtime-owner.ts";

export let runtimeOwner: RuntimeOwner | undefined;
export async function runtimeBuild(): Promise<RuntimeBuild | null> {
	try {
		const handle = await open(new URL("../../../runtime-build.json", import.meta.url), "r");
		let raw: Buffer;
		try {
			if (!(await handle.stat()).isFile()) throw new Error("runtime_build_invalid");
			raw = Buffer.alloc(4097);
			const { bytesRead } = await handle.read(raw);
			if (bytesRead > 4096) throw new Error("runtime_build_invalid");
			raw = raw.subarray(0, bytesRead);
		} finally {
			await handle.close();
		}
		const value = JSON.parse(raw.toString("utf8"));
		if (
			value.schema !== 1 ||
			!/^[a-f0-9]{40}$/.test(value.source) ||
			value.platform !== process.platform ||
			value.arch !== process.arch ||
			value.node !== process.versions.node ||
			value.protocol !== DAEMON_PROTOCOL_VERSION ||
			value.version !== release.version
		)
			throw new Error("runtime_build_invalid");
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
export async function bootstrapRuntime(): Promise<void> {
	const config = loadConfig(),
		bundled = process.argv.includes("--bundled-runtime");
	const build = await runtimeBuild();
	if (bundled && !build) throw new Error("runtime_build_missing");
	runtimeOwner = await ownRuntime(
		config.home,
		config.port,
		bundled,
		build,
		build ? await realpath(fileURLToPath(new URL("../../../", import.meta.url))) : undefined,
	);
	if (bundled) {
		await activateRuntime(runtimeOwner);
	}
}
export async function activateRuntime(owner: RuntimeOwner): Promise<void> {
	// Commit BEFORE the service graph can migrate/restore work. Before this point a parent
	// disconnect/timeout can safely reap this exact child. After it, the daemon is independent.
	if (!process.send) {
		await owner.close();
		throw new Error("runtime_parent_missing");
	}
	await new Promise<void>((ok, reject) => {
		const timer = setTimeout(() => reject(new Error("runtime_activation_timeout")), 10_000);
		const lost = () => {
			clearTimeout(timer);
			reject(new Error("runtime_activation_canceled"));
		};
		process.once("disconnect", lost);
		process.once("message", (value) => {
			clearTimeout(timer);
			process.removeListener("disconnect", lost);
			if (value !== "activate") {
				reject(new Error("runtime_activation_invalid"));
				return;
			}
			process.send?.("activated", () => {
				if (process.connected) process.disconnect();
				ok();
			});
		});
		process.send?.("owned");
	}).catch(async (error) => {
		await owner.close();
		throw error;
	});
}
