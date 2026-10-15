/** Trusted configuration read, outside the agent sandbox and off pilotd's event loop. Never loads resources. */
import { parentPort, workerData } from "node:worker_threads";
import { ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";

try {
	const { cwd, trustDirectory, agentDir } = workerData as { cwd: string; trustDirectory?: string; agentDir: string };
	parentPort!.postMessage({
		trusted:
			new ProjectTrustStore(agentDir).get(trustDirectory ?? cwd) ??
			SettingsManager.create(cwd, agentDir).getDefaultProjectTrust() === "always",
	});
} catch {
	parentPort!.postMessage({ error: true });
}
parentPort!.close();
