/** Preserve Pi's native model/auth choices while removing all executable resource configuration. */
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import {
	AgentSession,
	type CreateAgentSessionOptions,
	ModelRuntime,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

export function askSettings(settings: SettingsManager): SettingsManager {
	// Snapshot the merged model settings in memory so reload cannot restore packages or extensions.
	// ModelRuntime remains the normal SDK runtime, including models.json and trusted user auth helpers.
	return SettingsManager.inMemory({
		...settings.getSettings(),
		cacheWarming: "off",
		compaction: { enabled: false },
		retry: { enabled: false },
		packages: [],
		extensions: [],
		skills: [],
		prompts: [],
		themes: [],
		defaultTools: [],
	});
}

/** The SDK factory constructs all builtins even with an allowlist. Ask must not construct them. */
export async function createAskSession(
	options: Required<
		Pick<
			CreateAgentSessionOptions,
			"cwd" | "agentDir" | "settingsManager" | "sessionManager" | "resourceLoader" | "customTools" | "tools"
		>
	> &
		Pick<CreateAgentSessionOptions, "modelRuntime" | "model">,
): Promise<AgentSession> {
	const { settingsManager, sessionManager } = options;
	// Use the canonical runtime unchanged: native credentials, refresh and models.json helpers.
	const modelRuntime =
		options.modelRuntime ??
		(await ModelRuntime.create({
			authPath: join(options.agentDir, "auth.json"),
			modelsPath: join(options.agentDir, "models.json"),
		}));
	const existing = sessionManager.buildSessionContext();
	const provider = settingsManager.getDefaultProvider();
	const id = settingsManager.getDefaultModel();
	const configured = provider && id ? modelRuntime.getModel(provider, id) : undefined;
	const restored = existing.model ? modelRuntime.getModel(existing.model.provider, existing.model.modelId) : undefined;
	const model =
		options.model ??
		(restored && modelRuntime.hasConfiguredAuth(restored.provider) ? restored : undefined) ??
		(configured && modelRuntime.hasConfiguredAuth(configured.provider) ? configured : undefined) ??
		modelRuntime.getAvailableSnapshot()[0];
	const requestedThinking = existing.messages.length
		? existing.thinkingLevel
		: ((model && settingsManager.getModelThinkingLevel(model.provider, model.id)) ??
			settingsManager.getDefaultThinkingLevel() ??
			"medium");
	const knownThinking =
		(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).find(
			(level) => level === requestedThinking,
		) ?? "medium";
	const thinkingLevel = model ? clampThinkingLevel(model, knownThinking) : "off";
	const agent = new Agent({
		initialState: { systemPrompt: "", model, thinkingLevel, tools: [], messages: existing.messages },
		// The Harness is the only model loop; no alternate native stream path may be invoked.
		streamFn: () => {
			throw new Error("Only durable Harness may run the worker model loop");
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	});
	if (!existing.messages.length) {
		if (model) sessionManager.appendModelChange(model.provider, model.id);
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}
	return new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: options.cwd,
		resourceLoader: options.resourceLoader,
		modelRuntime,
		baseToolsOverride: {}, // Not hidden, inactive or filtered: unsafe builtin definitions never exist.
		customTools: options.customTools,
		initialActiveToolNames: options.tools,
		allowedToolNames: options.tools,
		usesDefaultTools: false,
	});
}
