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
}

/** Availability on this host, not permissions granted by a client or lifecycle control for another host. */
export interface DaemonCapabilities {
	/** Bounded active-session cwd path candidates; no home/project-root fallback. */
	sessionPathCandidates?: 1;
	/** Failure-fenced passive next-attempt model preferences. */
	passiveFailedModel?: true;
	/** Atomic captured-row admission for queue edits/removals. */
	guardedQueue?: true;
	powerManagement: boolean;
	systemSleepEvents: boolean;
	swiftUIArtifacts: boolean;
	/** False means coordinator workers must not run. There is no unrestricted fallback. */
	coordinatorIsolation: boolean;
	/** Agents and daemon-owned processes do not depend on a client connection. */
	independentExecution: boolean;
	/** Instance/boot-fenced workspace terminal handshake. Absent on older runtimes. */
	workspaceTerminalProtocol?: 2;
	/** Project environment setup (docs/environment-setup.md). Absent on older runtimes and while the feature is off. */
	environmentSetup?: 1;
	/** Bounded local accounting query API. Absent on older hosts, unrelated to subscription windows. */
	usageQueries?: 1;
	/** Existing-chat conversion rejects changed membership atomically. Missing on older runtimes. */
	guardedMissionConversion?: true;
	/** Status-only mission lifecycle with durable chat/wake suppression. */
	passiveMissionLifecycle?: true;
	/** Explicit task preference saves without reconciliation or agent work. */
	passiveTaskModel?: true;
}
