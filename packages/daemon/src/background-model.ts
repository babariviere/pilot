/**
 * The one signed-in model background work (Slack classification, memory compaction) uses, whatever the chat model
 * list (enabledModels) holds.
 */
export const BACKGROUND_FIXED_MODEL = { provider: "openai-codex", id: "gpt-6-luna" } as const;
