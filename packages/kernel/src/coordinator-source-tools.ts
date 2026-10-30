/** Bounded native source tools. Each execution obtains a fresh host scope, never a saved grant. */
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	getDocsPath,
	getExamplesPath,
	getReadmePath,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { ARTIFACT_SKILL_FILES } from "./artifact-skill.ts";
import { ASK_ATTACHMENTS, createAskTools } from "./ask-tools.ts";
import { coordinatorSkillRead } from "./coordinator-skill-resources.ts";
import type { ReadCoordinatorSourceAccess } from "./coordinator-sources.ts";
import { contained, sourceContentPath, sourcePath } from "./source-reader.ts";

/** Direct native writes and applyPatch's existing guard share the same scratch-only check. */
export function assertCoordinatorScratchWrite(scratch: string, path: string): void {
	if (!isAbsolute(path)) throw new Error("Coordinator scratch writes require an absolute path");
	sourcePath(scratch, path);
	let existing = path;
	for (;;) {
		try {
			const stat = lstatSync(existing);
			if (stat.isSymbolicLink()) throw new Error("Coordinator scratch writes do not follow symlinks");
			if (stat.isFile() && stat.nlink !== 1) throw new Error("Coordinator scratch hardlink write denied");
			if (!contained(realpathSync(scratch), realpathSync(existing)))
				throw new Error("Coordinator scratch write escape denied");
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(existing);
			if (parent === existing) throw error;
			existing = parent;
		}
	}
}

export async function createCoordinatorSourceTools(
	readScope: ReadCoordinatorSourceAccess,
	cwd: string,
	checkConfiguredRead: (path: string, recursive: boolean) => void,
): Promise<ToolDefinition[]> {
	// Reuse Ask's bounded text/image encoders, glob/literal search and no-symlink readers.
	const templates = await createAskTools({ source: cwd });
	return [
		defineTool({
			name: "source_roots",
			label: "Source roots",
			description:
				"List the current main-view, member workspaces and scratch paths. Each subsequent source call rechecks membership; this result is not a reusable access grant.",
			parameters: Type.Object({}),
			outputSchema: Type.Object({
				main: Type.String(),
				members: Type.Array(Type.Object({ sessionId: Type.String(), path: Type.String() })),
				scratch: Type.String(),
			}),
			async execute(_id, _args, signal) {
				const scope = await readScope(signal);
				const roots = { main: scope.main, members: scope.members, scratch: scope.scratch };
				return {
					content: [{ type: "text", text: JSON.stringify(roots) }],
					details: undefined,
					structuredContent: roots,
				};
			},
		}),
		...templates.map(
			(template): ToolDefinition => ({
				...template,
				description: `${template.description} Coordinator paths default to current main; use an absolute path from source_roots for a member or scratch. Repository metadata is unavailable.`,
				async execute(id, params, signal, update, ctx) {
					const scope = await readScope(signal);
					signal?.throwIfAborted();
					const args = params as Record<string, unknown>;
					const input = args.path ?? ".";
					if (typeof input !== "string") throw new Error("Coordinator source path must be a string");
					// Validate the spelling before resolving; normalization must not hide traversal.
					if (input.includes("\0") || input.split(/[\\/]/).includes(".."))
						throw new Error("Coordinator source traversal denied");
					let absolute = resolve(scope.main, input);
					// Preserve the host's TMPDIR spelling, not arbitrary aliases supplied by a caller.
					if (isAbsolute(input) && contained(cwd, absolute) && realpathSync(cwd) === scope.scratch)
						absolute = resolve(scope.scratch, sourcePath(cwd, absolute));
					const root = [scope.main, ...scope.members.map((member) => member.path), scope.scratch].find((root) =>
						contained(root, absolute),
					);
					let selected = root;
					let sourceOnly = true;
					// Host-owned documentation and pasted images are read-only exceptions, not source/search roots.
					if (!selected && template.name === "read") {
						if ([...ARTIFACT_SKILL_FILES, getReadmePath()].includes(absolute)) selected = dirname(absolute);
						else if ([getDocsPath(), getExamplesPath()].some((root) => contained(root, absolute)))
							selected = contained(getDocsPath(), absolute) ? getDocsPath() : getExamplesPath();
						else if (
							contained(ASK_ATTACHMENTS, absolute) &&
							/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.png$/i.test(
								relative(ASK_ATTACHMENTS, absolute),
							)
						)
							selected = ASK_ATTACHMENTS;
						sourceOnly = false;
					}
					if (template.name === "read" && (!selected || selected === root)) {
						const resource = coordinatorSkillRead(absolute, scope.skills);
						if (resource) {
							if (root) sourceContentPath(root, absolute);
							checkConfiguredRead(absolute, false);
							selected = resource.root;
							absolute = resource.path;
							// Keep source alias/hardlink checks on skill references as well.
							sourceOnly = true;
						}
					}
					if (!selected)
						throw new Error("Coordinator source path is outside current main, member workspaces and scratch");
					checkConfiguredRead(template.name.startsWith("code_") ? selected : absolute, template.name !== "read");
					const path = sourceContentPath(selected, absolute);
					const forwarded: Record<string, unknown> = { ...args, path };
					if (template.name === "code_call_paths" && args.symbol && typeof args.symbol === "object") {
						const symbol = args.symbol as Record<string, unknown>;
						if (typeof symbol.path !== "string") throw new Error("Call-path symbol needs a source path");
						forwarded.symbol = { ...symbol, path: sourceContentPath(selected, symbol.path) };
					}
					const tools = await createAskTools({ source: selected, ...(sourceOnly ? { sourceOnly: true } : {}) });
					return tools.find((tool) => tool.name === template.name)!.execute(id, forwarded, signal, update, ctx);
				},
			}),
		),
	];
}
