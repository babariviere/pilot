/**
 * A hint, never proof: the agent ran a Git or jj write that may have created, moved or pushed a branch or bookmark.
 * pilotd reads the workspace branch only after these commands, so a branch the agent merely checked out to look
 * at is never adopted, then rechecks the session's pull requests right away. Ownership of PRs still comes only from
 * pull-request-provenance.ts.
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Extension } from "@earendil-works/pi-durable";

const REF_CHANGE =
	/(?:^|[\s;&|(])(?:jj\s+(?:bookmark|b)\s+(?:create|c|set|s|move|m|rename|r|track|t|delete|d|forget|f)\b|jj\s+(?:commit|ci|describe|desc|squash|split)\b|jj\s+git\s+push\b|git\s+(?:push|commit)\b|git\s+(?:checkout|switch)\s+-[bcBC]\b|git\s+branch\s+\S|gh\s+(?:pr\s+(?:create|ready|edit|reopen)|stack\s+link)\b)/;

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
