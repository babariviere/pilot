/** Host-owned Ask tools. No model-supplied command, executable, revision or Git pathspec is accepted. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { createReadToolDefinition, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ARTIFACT_SKILL_FILES } from "./artifact-skill.ts";
import { createExplorationTools, EXPLORATION_TOOL_NAMES } from "./exploration-tools.ts";
import type { AskContext } from "./policy.ts";
import { contained, ReadLimitError, readLocal, SourceReader } from "./source-reader.ts";

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_SEARCH_BYTES = 32 * 1024 * 1024;
const UUID_PNG = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.png$/i;
export const ASK_ATTACHMENTS = join(homedir(), "Library", "Application Support", "Pilot", "Attachments");
export const ASK_TOOL_NAMES = [
	"read",
	"find",
	"grep",
	"ls",
	"codemode",
	"artifact",
	"mission",
	"ask_user",
	"web",
	...EXPLORATION_TOOL_NAMES,
];
const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function result(value: string) {
	const truncated = Buffer.byteLength(value) > MAX_OUTPUT_BYTES;
	const text = truncated
		? `${Buffer.from(value).subarray(0, MAX_OUTPUT_BYTES).toString("utf8")}\n[Output truncated; narrow the query.]`
		: value;
	return { content: [{ type: "text" as const, text }], details: undefined, structuredContent: text };
}

/** find uses a small glob matcher, grep uses literal strings, never user-controlled regex execution. */
function glob(pattern: string): (path: string) => boolean {
	if (pattern.length > 512) throw new Error("Ask find pattern is too long");
	const tokens = pattern.match(/\*\*|[\s\S]/g) ?? [];
	// Dynamic programming, O(pattern * path). No regex backtracking from adversarial wildcard chains.
	return (path) => {
		let previous = new Uint8Array(path.length + 1);
		previous[0] = 1;
		for (const token of tokens) {
			const next = new Uint8Array(path.length + 1);
			if (token === "*" || token === "**") next[0] = previous[0]!;
			for (let index = 1; index <= path.length; index++) {
				const char = path[index - 1];
				next[index] =
					token === "*" || token === "**"
						? Number(!!previous[index] || (!!next[index - 1] && (token === "**" || char !== "/")))
						: Number(!!previous[index - 1] && (token === "?" ? char !== "/" : token === char));
			}
			previous = next;
		}
		return previous[path.length] === 1;
	};
}

export async function createAskTools(
	ask: AskContext,
	options: { artifactSkill?: boolean } = {},
): Promise<ToolDefinition[]> {
	const reader = new SourceReader(ask);
	if (ask.commit && (await reader.git(["cat-file", "-t", ask.commit])).toString().trim() !== "commit")
		throw new Error("Ask snapshot must pin a commit object");
	const path = Type.Optional(
		Type.String({ maxLength: 4096, description: "Source-relative directory, defaults to source root." }),
	);
	const limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 }));
	return [
		...createExplorationTools(ask),
		defineTool({
			name: "read",
			annotations: readOnlyAnnotations,
			label: "read",
			description:
				"Read source text or images, a Pilot pasted UUID.png attachment, or the bundled pilot-artifacts skill files by absolute path when enabled. Source paths are rooted and symlinks are denied. Maximum file size 16 MiB, text output 50 KiB / 2000 lines. Use offset and limit to page text.",
			parameters: Type.Object({
				path: Type.String({ maxLength: 4096 }),
				offset: Type.Optional(Type.Integer({ minimum: 1 })),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
			}),
			outputSchema: Type.Union([
				Type.String(),
				Type.Object({
					type: Type.Literal("image"),
					data: Type.String(),
					mimeType: Type.String(),
					note: Type.String(),
				}),
			]),
			async execute(id, args, signal, onUpdate, ctx) {
				signal?.throwIfAborted();
				let bytes: Buffer;
				const absolute = resolve(reader.root, args.path);
				if (options.artifactSkill && ARTIFACT_SKILL_FILES.includes(args.path)) {
					// Exact host-owned documents only. Never grant access to their directories,
					// siblings, aliases, or model-supplied skill paths (including pinned-tree Ask).
					bytes = await readFile(args.path, { signal });
				} else if (
					isAbsolute(args.path) &&
					contained(ASK_ATTACHMENTS, absolute) &&
					UUID_PNG.test(basename(absolute)) &&
					relative(ASK_ATTACHMENTS, absolute) === basename(absolute)
				)
					bytes = await readLocal(ASK_ATTACHMENTS, args.path, signal);
				else bytes = await reader.read(args.path, signal);
				const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
					? "image/png"
					: bytes[0] === 255 && bytes[1] === 216
						? "image/jpeg"
						: bytes.subarray(0, 3).toString() === "GIF"
							? "image/gif"
							: bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP"
								? "image/webp"
								: undefined;
				if (mime) {
					// Reuse the SDK image encoder with only already-validated bytes, never its filesystem operations.
					const tool = createReadToolDefinition(reader.root, {
						operations: {
							access: async () => {},
							readFile: async () => bytes,
							detectImageMimeType: async () => mime,
						},
					});
					return tool.execute(id, args, signal, onUpdate, ctx);
				}
				if (bytes.includes(0)) throw new Error("Ask read does not render binary files");
				const lines = bytes.toString("utf8").split("\n");
				const start = (args.offset ?? 1) - 1;
				const end = Math.min(start + (args.limit ?? 2000), lines.length);
				return result(
					lines.slice(start, end).join("\n") +
						(end < lines.length ? `\n[More lines available; use offset=${end + 1}.]` : ""),
				);
			},
		}),
		defineTool({
			name: "ls",
			annotations: readOnlyAnnotations,
			label: "ls",
			description:
				"List source directory entries, marking directories and unfollowed symlinks/submodules. Output is bounded.",
			parameters: Type.Object({ path, limit }),
			outputSchema: Type.String(),
			async execute(_id, args, signal) {
				const entries = await reader.list(args.path ?? ".", signal);
				const count = args.limit ?? 1000;
				return result(
					entries
						.slice(0, count)
						.map(
							(entry) =>
								`${entry.name}${entry.kind === "directory" ? "/" : entry.kind === "file" ? "" : ` [${entry.kind}]`}`,
						)
						.join("\n") + (entries.length > count ? "\n[Entries truncated.]" : ""),
				);
			},
		}),
		defineTool({
			name: "find",
			annotations: readOnlyAnnotations,
			label: "find",
			description:
				"Find source files by glob (*, **, ?). Matches source-relative paths or basenames. Skips symlinks, submodules, .git, .jj and node_modules. Bounded to 10000 visited entries.",
			parameters: Type.Object({ path, pattern: Type.String(), limit }),
			outputSchema: Type.String(),
			async execute(_id, args, signal) {
				const matcher = glob(args.pattern);
				const found: string[] = [];
				for await (const name of reader.walk(args.path ?? ".", signal)) {
					if (matcher(name) || matcher(basename(name))) found.push(name);
					if (found.length >= (args.limit ?? 1000)) return result(`${found.join("\n")}\n[Match limit reached.]`);
				}
				return result(found.join("\n"));
			},
		}),
		defineTool({
			name: "grep",
			annotations: readOnlyAnnotations,
			label: "grep",
			description:
				"Search source text for a literal string, not a regular expression. Reports path:line:text. Skips binary files, symlinks, submodules and metadata/dependency directories. Bounded to 32 MiB scanned and 10000 entries. Narrow path for large repositories.",
			parameters: Type.Object({
				path,
				pattern: Type.String({ minLength: 1, maxLength: 1024 }),
				ignoreCase: Type.Optional(Type.Boolean()),
				limit,
			}),
			outputSchema: Type.String(),
			async execute(_id, args, signal) {
				const found: string[] = [];
				let scanned = 0;
				let skipped = 0;
				const needle = args.ignoreCase ? args.pattern.toLowerCase() : args.pattern;
				for await (const name of reader.files(args.path ?? ".", signal)) {
					let bytes: Buffer;
					try {
						bytes = await reader.read(name, signal);
					} catch (error) {
						signal?.throwIfAborted();
						if (
							error instanceof ReadLimitError ||
							["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")
						) {
							skipped++;
							continue;
						}
						throw error;
					}
					scanned += bytes.length;
					if (scanned > MAX_SEARCH_BYTES)
						return result(`${found.join("\n")}\n[Search byte limit reached; narrow path.]`);
					if (bytes.includes(0)) continue;
					const lines = bytes.toString("utf8").split("\n");
					for (let index = 0; index < lines.length; index++) {
						signal?.throwIfAborted();
						const line = lines[index]!;
						if ((args.ignoreCase ? line.toLowerCase() : line).includes(needle))
							found.push(`${name}:${index + 1}:${line.slice(0, 2000)}`);
						if (found.length >= (args.limit ?? 1000))
							return result(`${found.join("\n")}\n[Match limit reached.]`);
					}
				}
				return result(found.join("\n") + (skipped ? `\n[Skipped ${skipped} oversized or unreadable files.]` : ""));
			},
		}),
	];
}
