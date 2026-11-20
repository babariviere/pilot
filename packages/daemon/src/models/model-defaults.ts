/** Passive projection of the pinned SDK's Build startup, without constructing a session. */
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime, ScopedModel, SettingsManager } from "@earendil-works/pi-coding-agent";

type Thinking = NonNullable<ReturnType<SettingsManager["getDefaultThinkingLevel"]>>;
type Model = ScopedModel["model"];

// The SDK does not export its startup resolver/default constant at the package root.
// Load those exact pinned implementations rather than copying provider fallback policy.
const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
const { findInitialModel } = (await import(new URL("./core/model-resolver.js", sdk).href)) as {
	findInitialModel(options: {
		scopedModels: ScopedModel[];
		isContinuing: boolean;
		defaultProvider?: string;
		defaultModelId?: string;
		defaultThinkingLevel?: Thinking;
		modelThinkingLevels?: Record<string, Thinking>;
		modelRuntime: ModelRuntime;
	}): Promise<{ model?: Model }>;
};
const { DEFAULT_THINKING_LEVEL } = (await import(new URL("./core/defaults.js", sdk).href)) as {
	DEFAULT_THINKING_LEVEL: Thinking;
};

export async function newChatDefaults(settings: SettingsManager, runtime: ModelRuntime) {
	let initial: { model?: Model; thinking: Thinking } | undefined;
	// Older/incomplete adapters may lack passive auth metadata. Never replace it with checkAuth/getAuth.
	if (
		typeof runtime.getModel === "function" &&
		typeof runtime.hasConfiguredAuth === "function" &&
		typeof runtime.getAvailableSnapshot === "function"
	) {
		try {
			// createAgentSession deliberately passes [] here, not enabledModels.
			const { model } = await findInitialModel({
				scopedModels: [],
				isContinuing: false,
				defaultProvider: settings.getDefaultProvider(),
				defaultModelId: settings.getDefaultModel(),
				defaultThinkingLevel: settings.getDefaultThinkingLevel(),
				modelThinkingLevels: settings.getAllModelThinkingLevels(),
				modelRuntime: runtime,
			});
			initial = {
				model,
				thinking: model
					? clampThinkingLevel(model, configuredThinking(settings, model) ?? DEFAULT_THINKING_LEVEL)
					: "off",
			};
		} catch {
			// An unavailable passive snapshot is not permission to resolve credentials or start a model.
		}
	}
	return {
		model: initial?.model,
		thinking(model: Model): Thinking | undefined {
			if (!model.reasoning) return "off";
			// NativeAdapter applies an explicit picker model using setModel AFTER SDK startup.
			// Without configured thinking, that inherits the initial model's already-clamped level.
			const requested = configuredThinking(settings, model) ?? initial?.thinking;
			return requested === undefined ? undefined : clampThinkingLevel(model, requested);
		},
	};
}

function configuredThinking(settings: SettingsManager, model: Model): Thinking | undefined {
	return settings.getModelThinkingLevel(model.provider, model.id) ?? settings.getDefaultThinkingLevel();
}

/** changeModel applies a scope pin last. Otherwise an unconfigured switch retains session thinking. */
export function modelChangeThinking(settings: SettingsManager, model: Model, pin?: Thinking): Thinking | undefined {
	if (!model.reasoning) return "off";
	const requested = pin ?? configuredThinking(settings, model);
	return requested === undefined ? undefined : clampThinkingLevel(model, requested);
}

/** Shared with actual task-start selection, whose fallback intentionally differs from setModel. */
export function taskDefaultThinking(settings: SettingsManager, model: Model, pin?: string): Thinking {
	return clampThinkingLevel(model, (pin ?? configuredThinking(settings, model) ?? "medium") as Thinking);
}
