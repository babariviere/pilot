/** Read-only reference sources outside the project: pinned dependency sources and linked projects' main views. */
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAskTools } from "../ask/ask-tools.ts";
import { EXPLORATION_TOOL_NAMES } from "../exploration/exploration-tools.ts";
import { contained, sourceContentPath } from "./source-reader.ts";

/** Resolved by pilotd from lock files and project settings, never from model input. Paths are canonical directories. */
export interface ReferenceSource {
	kind: "dependency" | "linked";
	name: string;
	version?: string;
	/** Only required through another dependency. Readable, listed only when a name filter matches. */
	indirect?: true;
	path: string;
}
export type ReadReferenceSources = (signal?: AbortSignal) => Promise<ReferenceSource[]>;

export const REFERENCE_SOURCES_TOOL = "reference_sources";
const READ_TOOLS = new Set(["read", "ls", "find", "grep", ...EXPLORATION_TOOL_NAMES]);
// Model tokens: one line is about 100 characters. 200 lines fit the 80 direct Go modules of a real service with room.
const LIST_LIMIT = 200;

/** The innermost reference root holding this absolute path, if any. */
export function referenceRoot(references: readonly ReferenceSource[], path: string): ReferenceSource | undefined {
	let found: ReferenceSource | undefined;
	for (const reference of references)
		if (contained(reference.path, path) && (!found || reference.path.length > found.path.length)) found = reference;
	return found;
}

/** Source paths of one read tool call, relative to root. Traversal and repository metadata are refused. */
export function rebaseSourceArguments(
	name: string,
	args: Record<string, unknown>,
	root: string,
	path: string,
): Record<string, unknown> {
	const forwarded: Record<string, unknown> = { ...args, path: sourceContentPath(root, path) };
	if (name === "code_call_paths" && args.symbol && typeof args.symbol === "object") {
		const symbol = args.symbol as Record<string, unknown>;
		if (typeof symbol.path !== "string") throw new Error("Call-path symbol needs a source path");
		forwarded.symbol = { ...symbol, path: sourceContentPath(root, symbol.path) };
	}
	if (name === "code_impact" && Array.isArray(args.symbols))
		forwarded.symbols = args.symbols.map((symbol: unknown) => {
			if (!symbol || typeof symbol !== "object" || !("path" in symbol) || typeof symbol.path !== "string")
				throw new Error("Impact symbol needs a source path");
			return { ...symbol, path: sourceContentPath(root, symbol.path) };
		});
	return forwarded;
}

function absolute(path: unknown): string | undefined {
	if (typeof path !== "string") return undefined;
	const expanded = path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path;
	return isAbsolute(expanded) ? expanded : undefined;
}

/**
 * Absolute paths inside a reference source go to a fresh source-only reader rooted there.
 * Every call reads the current host list; other paths keep the tool's own checks.
 */
export function withReferenceSources(
	tools: ToolDefinition[],
	source: string,
	read: ReadReferenceSources | undefined,
): ToolDefinition[] {
	if (!read) return tools;
	return tools.map(
		(tool): ToolDefinition =>
			!READ_TOOLS.has(tool.name)
				? tool
				: {
						...tool,
						async execute(id, params, signal, update, ctx) {
							const args = params as Record<string, unknown>;
							const path = absolute(args.path);
							if (!path || contained(resolve(source), resolve(path)))
								return tool.execute(id, params, signal, update, ctx);
							const reference = referenceRoot(await read(signal), resolve(path));
							if (!reference) return tool.execute(id, params, signal, update, ctx);
							const forwarded = rebaseSourceArguments(tool.name, args, reference.path, path);
							const delegate = (await createAskTools({ source: reference.path, sourceOnly: true })).find(
								(candidate) => candidate.name === tool.name,
							)!;
							return delegate.execute(id, forwarded, signal, update, ctx);
						},
					},
	);
}

export function referenceLine(reference: ReferenceSource): string {
	const label =
		reference.kind === "linked" ? `${reference.name} (linked project)` : `${reference.name}@${reference.version}`;
	return `${label} → ${reference.path}`;
}

export function createReferenceSourcesTool(read: ReadReferenceSources): ToolDefinition {
	return defineTool({
		name: REFERENCE_SOURCES_TOOL,
		label: "Reference sources",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		description:
			"List read-only sources outside this project: the exact dependency versions its go.mod, Cargo.lock or package lock pins, and linked Pilot projects. Pass their absolute paths to read, ls, find, grep and code_* tools. Indirect dependencies are listed only when name matches.",
		parameters: Type.Object({
			name: Type.Optional(Type.String({ maxLength: 256, description: "Case-insensitive name filter." })),
		}),
		outputSchema: Type.String(),
		async execute(_id, args, signal) {
			const all = await read(signal);
			const filter = args.name?.toLowerCase();
			const shown = all.filter((reference) =>
				filter ? reference.name.toLowerCase().includes(filter) : !reference.indirect,
			);
			const lines = shown.slice(0, LIST_LIMIT).map(referenceLine);
			if (shown.length > LIST_LIMIT) lines.push(`[${shown.length - LIST_LIMIT} more; pass name to narrow.]`);
			const indirect = filter ? 0 : all.filter((reference) => reference.indirect).length;
			if (indirect) lines.push(`[${indirect} indirect dependencies; pass name to find one.]`);
			const text = lines.join("\n") || "No reference sources.";
			return { content: [{ type: "text", text }], details: undefined, structuredContent: text };
		},
	});
}
