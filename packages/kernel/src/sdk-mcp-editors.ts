/** Private compatibility seam for the pinned SDK's two real MCP configuration writers. */
export interface SdkMcpEditor {
	addMcpServerConfig(path: string, name: string, config: { url: string }): boolean;
	updateMcpServerConfig(path: string, name: string, patch: { enabled: boolean }): void;
	removeMcpServerConfig(path: string, name: string): boolean;
}

export function loadSdkMcpEditor(source: "extension" | "cli"): Promise<SdkMcpEditor> {
	const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
	// Keep the compiled CLI writer covered too. SDK upgrades must update this explicit binding.
	const path = source === "extension" ? "./extensions/mcp/config.js" : "./bundle/chunks/chunk-MMDXLZVS.js";
	return import(new URL(path, sdk).href);
}
