/** Increment for incompatible API changes, independently of the application release version. */
export const DAEMON_PROTOCOL_VERSION = 1;
export const MINIMUM_CLIENT_PROTOCOL_VERSION = 1;

/** GET /api/hello. Read before opening streams or sending mutations to a newly connected host. */
export interface DaemonHello {
	/** Stable for this data home, across daemon restarts and runtime updates. Pin on first pairing. */
	daemonId: string;
	daemonVersion: string;
	protocolVersion: number;
	minimumClientProtocolVersion: number;
	platform: string;
	arch: string;
	capabilities: DaemonCapabilities;
}

/** Availability on this host, not permissions granted by a client or lifecycle control for another host. */
export interface DaemonCapabilities {
	powerManagement: boolean;
	systemSleepEvents: boolean;
	swiftUIArtifacts: boolean;
	/** False means coordinator workers must not run. There is no unrestricted fallback. */
	coordinatorIsolation: boolean;
	/** Agents and daemon-owned processes do not depend on a client connection. */
	independentExecution: boolean;
}
