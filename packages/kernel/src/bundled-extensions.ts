/** Required, pinned extensions, loaded through Pi's TypeScript extension loader, not Node imports. */
import { fileURLToPath } from "node:url";
import {
	PILOT_CHILD_PROFILE_PATH,
	PILOT_EXTENSION_NAMES,
	PILOT_PROFILE_PATH,
	PILOT_WEB_PATH,
} from "@babariviere/pi-extensions/profile";
import { EmbeddedResourceLoader } from "@babariviere/pi-extensions/resource-loader";
import {
	DefaultResourceLoader,
	type ModelRuntime,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export const ANTHROPIC_AUTH_PATH = fileURLToPath(import.meta.resolve("@gotgenes/pi-anthropic-auth/src/index.ts"));

export function bundledResourceLoader(
	options: ConstructorParameters<typeof DefaultResourceLoader>[0],
	projectTrusted: boolean,
	profile = true,
): EmbeddedResourceLoader {
	return new EmbeddedResourceLoader(options, {
		projectTrusted,
		requiredPaths: [...(profile ? [PILOT_PROFILE_PATH] : []), ANTHROPIC_AUTH_PATH],
		ownedPackages: {
			"@babariviere/pi-extensions": profile
				? [...PILOT_EXTENSION_NAMES.map((name) => `extensions/${name}`), "embedding/pilot.ts", "embedding/child.ts"]
				: [],
			"@gotgenes/pi-anthropic-auth": ["*"],
		},
	});
}

/** Only the bundled web definition, never personal/project factories or lifecycle hooks in Ask. */
export async function bundledAskTools(cwd: string, agentDir: string): Promise<ToolDefinition[]> {
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: SettingsManager.inMemory(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalExtensionPaths: [PILOT_WEB_PATH],
	});
	await loader.reload({ resolveProjectTrust: async () => false });
	const { extensions, errors } = loader.getExtensions();
	if (errors.length) throw new Error(`Bundled web extension failed: ${errors.map(({ error }) => error).join("; ")}`);
	return extensions.flatMap((extension) =>
		[...extension.tools.values()]
			.filter(({ definition }) => definition.name === "web")
			.map(({ definition }) => definition),
	);
}

/** Session workers pass trusted, absolute paths to children, without editing personal Pi settings. */
export function configureBundledChildren(): void {
	process.env.PILOT_PI_EXTENSIONS_PROFILE = PILOT_CHILD_PROFILE_PATH;
	process.env.PILOT_ANTHROPIC_AUTH_EXTENSION = ANTHROPIC_AUTH_PATH;
}

/** Tool-free daemon completions use the same required transport, with no personal extension runtime. */
export async function installBundledAnthropicAuth(runtime: ModelRuntime, agentDir: string): Promise<void> {
	const loader = new DefaultResourceLoader({
		cwd: agentDir,
		agentDir,
		settingsManager: SettingsManager.inMemory(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalExtensionPaths: [ANTHROPIC_AUTH_PATH],
	});
	await loader.reload();
	const result = loader.getExtensions();
	if (result.errors.length)
		throw new Error(
			`Required Anthropic auth extension failed: ${result.errors.map(({ error }) => error).join("; ")}`,
		);
	runtime.unregisterProvider("anthropic");
	for (const { name, config } of result.runtime.pendingProviderRegistrations) runtime.registerProvider(name, config);
}
