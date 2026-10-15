/** Compose only the services this host can provide. Linux never starts/retries native Mac helpers. */
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { promisify } from "node:util";
import type { DaemonCapabilities } from "@pilot/protocol";
import { probeLinuxCoordinatorIsolation } from "./linux-coordinator.ts";
import { powerHelperPath } from "./power-helper.ts";
import { systemEventsHelperPath } from "./system-events-helper.ts";

async function executable(path: string): Promise<boolean> {
	return access(path, constants.X_OK).then(
		() => true,
		() => false,
	);
}

export async function detectPlatformCapabilities(
	platform: string = process.platform,
	check = executable,
	swift = async () => {
		try {
			await promisify(execFile)("/usr/bin/xcrun", ["--find", "swiftc"], { timeout: 2000, maxBuffer: 4096 });
			return true;
		} catch {
			return false;
		}
	},
	linuxIsolation = probeLinuxCoordinatorIsolation,
): Promise<DaemonCapabilities> {
	if (platform !== "darwin") {
		const isolation = platform === "linux" ? await linuxIsolation() : { available: false };
		if (isolation.detail) console.warn(`pilotd: ${isolation.detail}`);
		return {
			powerManagement: false,
			systemSleepEvents: false,
			swiftUIArtifacts: false,
			coordinatorIsolation: isolation.available,
			independentExecution: true,
		};
	}
	const [powerManagement, systemSleepEvents, coordinatorIsolation] = await Promise.all([
		check(powerHelperPath()),
		check(`${systemEventsHelperPath()}/Contents/MacOS/PilotSystemEvents`),
		check("/usr/bin/sandbox-exec"),
	]);
	return {
		powerManagement,
		systemSleepEvents,
		coordinatorIsolation,
		swiftUIArtifacts: coordinatorIsolation && (await swift()),
		independentExecution: true,
	};
}
