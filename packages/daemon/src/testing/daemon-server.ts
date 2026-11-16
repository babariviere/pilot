import { createDaemonServices, type DaemonServiceDependencies } from "../daemon-services.ts";
import { createDaemonServer } from "../server.ts";

/** HTTP fixtures compose the same domain services explicitly, without a second production setup path. */
export function createDaemonFixtureServer(options: DaemonServiceDependencies) {
	const services = createDaemonServices(options);
	return Object.assign(createDaemonServer(services), { services });
}
