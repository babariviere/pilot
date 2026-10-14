// Privacy-safe native smoke check. Build/bundle the app first; never requests authorization.
import { setTimeout } from "node:timers/promises";
import { SystemEventsDetection } from "../../packages/daemon/src/wifi-detection.ts";

const detector = new SystemEventsDetection();
try {
	const state = await detector.status();
	console.log({
		authorization: state.authorization,
		available: state.available,
		hasCurrentNetwork: state.currentNetwork !== null,
		knownNetworkCount: state.knownNetworks.length,
		error: state.error,
	});
	let changes = 0;
	detector.subscribe(() => {
		changes++;
		console.log({ changes });
	});
	detector.setActive(true);
	await setTimeout(Number(process.argv[2] ?? 5) * 1000);
} finally {
	detector.stop();
}
