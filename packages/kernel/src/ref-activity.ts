/**
 * A hint, never proof: the agent ran a command that may have created, moved or pushed a branch or bookmark.
 * pilotd rechecks the session's pull requests right away instead of waiting for its polling cadence.
 * Ownership of PRs still comes only from pull-request-provenance.ts.
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Extension } from "@earendil-works/pi-durable";

const REF_CHANGE =
	/(?:^|[\s;&|(])(?:jj\s+(?:bookmark|b)\s+(?:create|c|set|s|move|m|rename|r|track|t|delete|d|forget|f)\b|jj\s+git\s+push\b|git\s+push\b|git\s+(?:checkout|switch)\s+-[bcBC]\b|git\s+branch\s+\S|gh\s+pr\s+(?:create|ready|edit|reopen)\b)/;

export function changesRefs(toolName: string, input: unknown): boolean {
	if (toolName !== "bash") return false;
	const command = (input as { command?: unknown } | undefined)?.command;
	return typeof command === "string" && REF_CHANGE.test(command);
}

/** Observes top-level tool calls through the durable wrapper and nested ones (codemode) natively. */
export function refActivity(onChange: () => void): {
	native: ExtensionFactory;
	prepare(extension: Extension): Extension;
} {
	return {
		native: (pi) => {
			pi.on("tool_result", (event) => {
				if (changesRefs(event.toolName, event.input)) onChange();
			});
		},
		prepare: (extension) => ({
			...extension,
			tools: extension.tools?.map((tool) => ({
				...tool,
				execute: async (args, api, context) => {
					try {
						return await tool.execute(args, api, context);
					} finally {
						// Even a failed push may have created the bookmark first.
						if (changesRefs(tool.name, args)) onChange();
					}
				},
			})),
		}),
	};
}
