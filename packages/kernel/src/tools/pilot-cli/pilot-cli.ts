import { execFile } from "node:child_process";
import { delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentCliCapability } from "../../worker/protocol.ts";
import { createAskTools } from "../ask/ask-tools.ts";

export const PILOT_CLI_TOOL = "pilot_cli";
export const PILOT_CLI_SKILL_NAME = "pilot-cli";
export const PILOT_CLI_SKILL_PATH = fileURLToPath(new URL("../../../skills/pilot-cli/SKILL.md", import.meta.url));

function cliEnvironment(grant: AgentCliCapability) {
	return { PILOT_CLI_PORT: String(grant.port), PILOT_CLI_TOKEN: grant.token };
}

/** Both Pi and the pinned bundled sandbox snapshot the environment before the first await. */
export function withPilotCliShell(
	execute: ToolDefinition["execute"],
	grant: AgentCliCapability,
): ToolDefinition["execute"] {
	return function (this: unknown, ...args) {
		const env = process.env;
		const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
		const overlay = {
			...cliEnvironment(grant),
			PILOT_CLI_NODE: process.execPath,
			[pathKey]: [grant.bin, env[pathKey]].filter(Boolean).join(delimiter),
		};
		const saved = Object.keys(overlay).map((key) => [key, env[key]] as const);
		try {
			Object.assign(env, overlay);
			// Do not await here. Restore before unrelated tools or extensions can run.
			return execute.apply(this, args);
		} finally {
			for (const [key, value] of saved) {
				if (value === undefined) delete env[key];
				else env[key] = value;
			}
		}
	};
}

/** Allow just the advertised skill document, with the same read limits as Ask's own source. */
export async function withPilotCliSkillRead(tools: ToolDefinition[]): Promise<ToolDefinition[]> {
	const skill = (await createAskTools({ source: dirname(PILOT_CLI_SKILL_PATH) })).find(
		(tool) => tool.name === "read",
	)!;
	return tools.map((tool) =>
		tool.name === "read"
			? {
					...tool,
					async execute(id, args, signal, update, ctx) {
						const input = args as { path: string; offset?: number; limit?: number };
						return input.path === PILOT_CLI_SKILL_PATH
							? skill.execute(id, { ...input, path: "SKILL.md" }, signal, update, ctx)
							: tool.execute(id, args, signal, update, ctx);
					},
				}
			: tool,
	);
}

// Cap each stream to protect model context, with room for several typical transcript entries.
const OUTPUT_LIMIT = 32 * 1024;

export function createPilotCliTool(grant: AgentCliCapability): ToolDefinition {
	return defineTool({
		name: PILOT_CLI_TOOL,
		label: "Pilot CLI",
		description:
			'Read Pilot context, chats, missions, Briefs, and tasks through the bundled read-only CLI. Use argv: ["--help"] for usage.',
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		parameters: Type.Object({
			// The CLI's longest form needs fewer than ten short arguments. Stay well under OS argv limits.
			argv: Type.Array(Type.String({ maxLength: 512, pattern: "^[^\\u0000]*$" }), { maxItems: 16 }),
		}),
		outputSchema: Type.String(),
		async execute(_id, { argv }, signal) {
			signal?.throwIfAborted();
			const value = await new Promise<string>((resolve, reject) => {
				execFile(
					process.execPath,
					[grant.entry, ...argv],
					{
						cwd: dirname(grant.entry),
						env: cliEnvironment(grant),
						shell: false,
						signal,
						killSignal: "SIGKILL",
						// The client has a five-second HTTP deadline. Leave time for process startup.
						timeout: 15_000,
						maxBuffer: OUTPUT_LIMIT,
					},
					(error, stdout, stderr) => {
						if (!error) resolve(stdout);
						else if (signal?.aborted) reject(signal.reason);
						else if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
							reject(new Error("Pilot CLI exceeded 32 KiB on stdout or stderr. Read fewer entries per call."));
						else if (error.killed) reject(new Error("Pilot CLI did not finish within 15 seconds."));
						else if (typeof error.code === "number")
							reject(new Error(stderr.trim() || `Pilot CLI exited with code ${error.code}.`));
						else reject(new Error("Could not run the bundled Pilot CLI."));
					},
				);
			});
			return { content: [{ type: "text", text: value }], structuredContent: value, details: undefined };
		},
	});
}
