/** Increment for incompatible API changes, independently of the application release version. */
export const DAEMON_PROTOCOL_VERSION = 1;
export const MINIMUM_CLIENT_PROTOCOL_VERSION = 1;

/** GET /api/hello. Read before opening streams or sending mutations to a newly connected host. */
export interface DaemonHello {
	/** Stable for this data home, across daemon restarts and runtime updates. Pin on first pairing. */
	daemonId: string;
	/** Storage-history fence, distinct from installation and transient connection identity. */
	lineageId?: string;
	daemonVersion: string;
	protocolVersion: number;
	minimumClientProtocolVersion: number;
	platform: string;
	arch: string;
	capabilities: DaemonCapabilities;
	/** Contract-only; populated only by a future verified cross-host Control implementation. */
	controlHost?: import("./control.ts").ControlHostConfiguration;
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
	/** Instance/boot-fenced workspace terminal handshake. Absent on older runtimes. */
	workspaceTerminalProtocol?: 2;
	/** Journal-backed detached Linux updates with startup/admission fencing. */
	runtimeUpdates?: 1;
	/** Cross-host Control contract version, independent of the general daemon protocol. */
	controlHosts?: 1;
}
