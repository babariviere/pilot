import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CallPathOutput, type CallPathQuery, CallSymbol } from "./call-path-contract.ts";
import { ExplorationOutput, type ExplorationQuery } from "./exploration-contract.ts";
import { runExploration } from "./exploration-runner.ts";
import { ImpactOutput, type ImpactQuery } from "./impact-contract.ts";
import type { AskContext } from "./policy.ts";

export const EXPLORATION_TOOL_NAMES = ["code_search", "code_symbols", "code_call_paths", "code_impact"];
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
	const execute = async (
		query: ExplorationQuery | CallPathQuery | ImpactQuery,
		signal: AbortSignal | undefined,
		ctx: ExtensionToolContext,
	) => {
		const selected = typeof source === "function" ? source(ctx) : source;
		const result = await runExploration(selected, query, signal);
		return {
			content: [{ type: "text" as const, text: JSON.stringify(result) }],
			details: undefined,
			structuredContent: result,
		};
	};
	return [
		defineTool({
			name: "code_impact",
			label: "Static caller impact",
			annotations,
			description:
				"Investigate possible caller impact of 1–8 exact TS/JS callables in one shared source scan. Returns deduplicated callers with one deterministic shortest source-edge witness to a nearest root, opaque observed-content revision, coverage and unknown call counts. Not general references, types, runtime tracing or complete impact; no callers is not a safety claim. Live reads are non-atomic; no persistent index. Include expectedRevision to reject changed observed content.",
			parameters: Type.Object({
				...common,
				symbols: Type.Array(CallSymbol, { minItems: 1, maxItems: 8 }),
				depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 6 })),
				expectedRevision: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
			}),
			outputSchema: ImpactOutput,
			execute: (_id, args, signal, _onUpdate, ctx) => execute({ ...args, tool: "code_impact" }, signal, ctx),
		}),
		defineTool({
			name: "code_call_paths",
			label: "Source call paths",
			annotations,
			description:
				"Explore bounded source-inferred callers/callees in TS/TSX/JS/JSX. Select exact declaration coordinates from code_symbols or returned frames (include contentHash/frameId to fence navigation). Returns callsite/frame spans and resolution provenance. Lexical direct calls and relative ESM only; no name-match linking, runtime stacks, type/dispatch or impact proof. Unknown/ambiguous calls, scan/depth/page limits are explicit. No callers found does not prove no impact. Fresh local read-only scan or host-pinned source, no code/config execution.",
			parameters: Type.Object({
				...common,
				symbol: CallSymbol,
				direction: Type.Union([Type.Literal("callers"), Type.Literal("callees")]),
				depth: Type.Optional(
					Type.Integer({
						minimum: 1,
						maximum: 6,
						description: "Traversal hops, default 1. Cycles are marked and not repeatedly expanded.",
					}),
				),
			}),
			outputSchema: CallPathOutput,
			execute: (_id, args, signal, _onUpdate, ctx) => execute({ ...args, tool: "code_call_paths" }, signal, ctx),
		}),
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
