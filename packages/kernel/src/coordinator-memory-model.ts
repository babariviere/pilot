import type { Models } from "@earendil-works/pi-ai";
export type MemoryModel = NonNullable<ReturnType<Models["getModel"]>>;

/** Internal role selected explicitly by the user, not a change to ordinary chat picker scope. */
export function coordinatorMemoryModel(provider: string, available: readonly MemoryModel[]): MemoryModel | undefined {
	const choice = {
		openai: ["gpt-6-luna", "openai-responses"],
		"openai-codex": ["gpt-6-luna", "openai-codex-responses"],
		anthropic: ["claude-haiku-5-5", "anthropic-messages"],
	}[provider];
	return choice
		? available.find((model) => model.provider === provider && model.id === choice[0] && model.api === choice[1])
		: undefined;
}
