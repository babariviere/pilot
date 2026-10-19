/** Reviewed setup only. Never credentials, expanded values, OAuth state or raw configuration. */
export interface McpShareConfig {
	type?: "stdio" | "http" | "streamable-http";
	url?: string;
	command?: string;
	args?: [];
	env?: Record<string, never>;
	headers?: Record<string, never>;
	enabled?: boolean;
	exposure?: "codemode" | "codemode-deferred" | "deferred" | "direct" | "hidden";
	timeout?: number;
}

export type McpShareBlock = "advanced_configuration" | "unsafe_url" | "local_command" | "invalid_configuration";
export interface McpSetupEntry {
	name: string;
	config?: McpShareConfig;
	blocked?: McpShareBlock;
	/** Stdio: executable found on this host's PATH. No process is started by this check. */
	dependencyAvailable?: boolean;
}
export interface McpSetupSnapshot {
	/** Bump before expanding the shareable field set. Older clients must refuse newer schemas. */
	schemaVersion: 1;
	/** Existing files require host-local editing until Pi coordinates config writes. */
	writeMode: "initial_only";
	/** Opaque whole-file revision, including fields not exported. Absence differs from an empty file. */
	revision: string;
	exists: boolean;
	entries: McpSetupEntry[];
	invalidNames: number;
}
export interface McpSetupApplyRequest {
	expectedRevision: string;
	entries: Array<{ name: string; config: McpShareConfig }>;
}
