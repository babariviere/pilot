import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ExplorationOutput, type ExplorationQuery } from "./exploration-contract.ts";
import { runExploration } from "./exploration-runner.ts";
import type { AskContext } from "./policy.ts";

export const EXPLORATION_TOOL_NAMES = ["code_search", "code_symbols"];
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** SDK definitions work directly and through codemode, including Ask's explicit allowlist. */
export function createExplorationTools(
	source: AskContext | ((ctx: ExtensionToolContext) => AskContext),
): ToolDefinition[] {
	const common = {
		path: Type.Optional(
			Type.String({
				maxLength: 4096,
				description: "Source-relative file/directory, defaults to root. Narrow for large repositories.",
			}),
		),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
		cursor: Type.Optional(
			Type.String({
				maxLength: 512,
				description: "Next cursor for this exact query/source. Every page rescans; edits invalidate it.",
			}),
		),
	};
	const execute = async (query: ExplorationQuery, signal: AbortSignal | undefined, ctx: ExtensionToolContext) => {
		const result = await runExploration(typeof source === "function" ? source(ctx) : source, query, signal);
		return {
			content: [{ type: "text" as const, text: JSON.stringify(result) }],
			details: undefined,
			structuredContent: result,
		};
	};
	return [
		defineTool({
			name: "code_search",
			label: "Code search",
			annotations,
			description:
				"Rank case-sensitive literal matches (first match per line) with TS/TSX/JS/JSX declaration context. Other UTF-8 text is lexical-only. Fresh source spans, hashes, coverage and bounded pages; not semantic search. Read-only, no project code/config execution. Ordinary read/grep remain available.",
			parameters: Type.Object({
				...common,
				query: Type.String({
					minLength: 1,
					maxLength: 256,
					description: "Single-line literal, not regex or natural-language semantic search.",
				}),
			}),
			outputSchema: ExplorationOutput,
			execute: (_id, args, signal, _onUpdate, ctx) => execute({ ...args, tool: "code_search" }, signal, ctx),
		}),
		defineTool({
			name: "code_symbols",
			label: "Code symbols",
			annotations,
			description:
				"Find parsed named declaration/definition candidates in TS/TSX/JS/JSX. Case-sensitive name substring (or exact); omit query to list. Precise source spans/snippets and content hashes. Not references, import resolution or type checking. Reports unsupported/partial coverage. Fresh read-only scan, no persistent index.",
			parameters: Type.Object({
				...common,
				query: Type.Optional(Type.String({ maxLength: 256 })),
				exact: Type.Optional(Type.Boolean()),
			}),
			outputSchema: ExplorationOutput,
			execute: (_id, args, signal, _onUpdate, ctx) => execute({ ...args, tool: "code_symbols" }, signal, ctx),
		}),
	];
}
