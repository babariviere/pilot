/** User extension tools that Ask sessions may call. Only their definitions are used, never their hooks. */
import { DefaultResourceLoader, type SettingsManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Tool names Ask borrows from the user's own (user-level) pi packages and extensions. */
export const ASK_EXTENSION_TOOL_NAMES = ["web"];

/**
 * Loads user-level extensions (agent directory and user packages, never project ones) and returns the
 * definitions of the allowed tools. Load failures are reported, not fatal: Ask still starts without them.
 */
export async function loadAskExtensionTools(options: {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
	onError?: (message: string) => void;
}): Promise<ToolDefinition[]> {
	const loader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager: options.settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	try {
		// Untrusted project: project settings, packages and .pi/extensions are never loaded.
		await loader.reload({ resolveProjectTrust: async () => false });
	} catch (error) {
		options.onError?.(`Ask extension tools unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
	const result = loader.getExtensions();
	for (const failure of result.errors)
		options.onError?.(`Ask extension load failed (${failure.path}): ${failure.error}`);
	const tools = new Map<string, ToolDefinition>();
	for (const extension of result.extensions) {
		if (extension.sourceInfo.scope === "project") continue;
		for (const [name, tool] of extension.tools)
			if (ASK_EXTENSION_TOOL_NAMES.includes(name) && !tools.has(name)) tools.set(name, tool.definition);
	}
	return [...tools.values()];
}
