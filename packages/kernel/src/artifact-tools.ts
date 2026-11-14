/** Pi SDK tools for publishing and inspecting session-local, offline artifacts. */
import type { JsonValue } from "@earendil-works/chord/json";
import { type AgentToolResult, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	ArtifactNotFound,
	type ArtifactStore,
	captureNshSource,
	imageSize,
	loadArtifactImage,
	MAX_IMAGE_SOURCE_BYTES,
	writeNshScratchSource,
} from "@pilot/artifacts";
import type {
	ArtifactImageSize,
	ArtifactReference,
	ArtifactRevision,
	ArtifactSummary,
	ArtifactWrite,
} from "@pilot/protocol";
import { Type } from "typebox";
import { ARTIFACT_SKILL_PATH } from "./artifact-skill.ts";
import { StringEnum } from "./schema.ts";

const MAX_SOURCE_BYTES = 512 * 1024;
const library = StringEnum(["react", "react-dom", "mermaid", "echarts", "motion", "d3", "three"] as const);
/** Read kinds. Visual, shader, HTML, React and SwiftUI revisions stay readable as saved, never written. */
const kind = StringEnum(["html", "react", "image", "swiftui", "shader", "visual", "nsh"] as const);
const writeProperties = {
	title: Type.String({ minLength: 1, maxLength: 160, description: "Short human-readable artifact title." }),
	source: Type.String({
		maxLength: MAX_IMAGE_SOURCE_BYTES,
		description: "Image only: a local file path or base64 image data URL (16 MiB decoded max).",
	}),
	libraries: Type.Optional(Type.Array(Type.String(), { maxItems: 0, description: "Deprecated; must be empty." })),
};
const summaryProperties = {
	id: Type.String(),
	sessionId: Type.String(),
	projectId: Type.Optional(Type.String()),
	title: Type.String(),
	kind,
	revision: Type.Integer({ minimum: 1 }),
	createdAt: Type.Number(),
	updatedAt: Type.Number(),
};
const referenceSchema = Type.Object({
	artifact: Type.Object({
		id: Type.String(),
		sessionId: Type.String(),
		title: Type.String(),
		revision: Type.Integer(),
	}),
	warnings: Type.Optional(Type.Array(Type.String())),
});
const revisionNumber = Type.Integer({ minimum: 1 });
export interface ArtifactToolOptions {
	store: Pick<ArtifactStore, "create" | "update" | "get" | "list">;
	/** Read-only daemon lookup for references linked to the caller's current mission. */
	readReference?: (id: string, revision?: number) => Promise<Omit<ArtifactRevision, "html"> | undefined>;
	/** Persist a display-only transcript reference, including publications nested inside codemode. Image revisions
	 * pass their header size so apps can reserve layout before reading the source. */
	onArtifactPublished?: (artifact: ArtifactReference, image?: ArtifactImageSize) => Promise<void>;
	onArtifactsChanged?: () => void;
	/** Ask permits session-local artifacts, but never arbitrary image-path reads. */
	ask?: boolean;
	/** Trusted host session root, never a caller-supplied path. Ask writes NSH source only into its scratch/artifacts. */
	nshSessionDirectory?: string;
	/** Host-owned capture+compile binding, never an executable/path selected by an artifact request. */
	captureNsh?: (sourcePath: string, signal?: AbortSignal) => Promise<{ source: string; entry: string }>;
}

/** Agents write only these kinds. The store still accepts others so old revisions keep their format. */
const WRITE_KINDS: readonly string[] = ["image", "nsh"];

function checkSource(write: ArtifactWrite): void {
	if (write.kind !== "image" && Buffer.byteLength(write.source, "utf8") > MAX_SOURCE_BYTES)
		throw new Error("Artifact source exceeds the 512 KiB UTF-8 limit");
}

function summary(value: ArtifactSummary) {
	return {
		id: value.id,
		sessionId: value.sessionId,
		...(value.projectId === undefined ? {} : { projectId: value.projectId }),
		title: value.title,
		kind: value.kind,
		revision: value.revision,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}

function dataResult<T extends JsonValue>(data: T): AgentToolResult<T> {
	return { content: [{ type: "text", text: JSON.stringify(data) }], details: data, structuredContent: data };
}

/** Register through createAgentSession(customTools), so codemode and extension hooks see these tools. */
export function createArtifactTools(options: ArtifactToolOptions): ToolDefinition[] {
	const { store } = options;
	const nsh = !!options.nshSessionDirectory;
	const scratch = JSON.stringify(`${options.nshSessionDirectory}/scratch/artifacts`);
	const offeredKinds: ArtifactWrite["kind"][] = nsh ? ["image", "nsh"] : ["image"];
	const actions = ["create", "update", "get", "list"] as const;
	const published = async (value: ArtifactRevision, warnings: string[] = []) => {
		const artifact = {
			id: value.id,
			sessionId: value.sessionId,
			title: value.title,
			revision: value.revision,
		};
		// Await durable admission before returning, even when called inside codemode. The store is
		// already committed: display failures must not report a failed write or encourage duplicates.
		try {
			await options.onArtifactPublished?.(artifact, value.kind === "image" ? imageSize(value.source) : undefined);
		} catch (error) {
			console.warn("pilot: artifact transcript reference could not be admitted", error);
		}
		try {
			options.onArtifactsChanged?.();
		} catch (error) {
			console.warn("pilot: artifact change notification failed", error);
		}
		return dataResult({ artifact, ...(warnings.length ? { warnings } : {}) });
	};
	return [
		defineTool({
			name: "artifact",
			label: "Artifact",
			namespace: {
				name: "artifacts",
				description: `Publish and inspect ${nsh ? "NSH and image" : "image"} artifacts with tools.artifact. Read the pilot-artifacts skill before creating or updating artifacts.`,
				instructions: `Read the bundled pilot-artifacts skill at ${ARTIFACT_SKILL_PATH} before creating or updating artifacts.`,
			},
			description: `Publish and inspect session-local offline artifacts. Read the pilot-artifacts skill before creating or updating artifacts.
- create: publish title, kind and source (sourcePath for nsh); returns a compact pinned reference.
- update: replace the complete document by id, not a patch; expectedRevision rejects stale updates.
- get: read source and metadata by id, optionally at a historical revision. Local artifacts read latest when revision is omitted. Linked mission/task references are read-only: omission uses the pinned revision, or latest for unpinned links; conflicting pins require an explicit linked revision.
- list: list current session summaries without source.
New artifacts use kind ${nsh ? "nsh or image" : "image"}. Visual, shader, HTML, React and SwiftUI artifacts are read-only: get and list still return them as saved.
${nsh ? `NSH: ${options.ask ? `pass the complete TSX as source and a .tsx basename as sourcePath; the tool writes that one file in ${scratch}, then captures and compiles it. Ask writes nothing else.` : `kind nsh captures and compiles one sourcePath (.tsx basename or absolute path in ${scratch}). Do not pass inline source.`} Compile errors publish nothing; fix the source and retry. Saved UTF-8 bytes are immutable and survive scratch cleanup. Compilation does not run the preview or fully typecheck TypeScript. No local/remote imports or assets are loaded. Source: 512 KiB UTF-8 max.\n` : ""}Images: 16 MiB decoded max. ${options.ask ? "Ask images accept only inline base64 data:image/... URLs, never file paths." : "Pass a local PNG, JPEG, GIF or WebP path or an inline data URL, never a remote URL."}
Get the current source before updating, and pass its revision as expectedRevision.`,
			promptSnippet: nsh
				? "Publish NSH or image artifacts; inspect older artifact sources"
				: "Publish image artifacts; inspect older artifact sources",
			executionMode: "sequential",
			annotations: { openWorldHint: false, destructiveHint: false },
			parameters: Type.Object({
				action: StringEnum(actions),
				id: Type.Optional(Type.String({ description: "Artifact ID, required for get and update." })),
				title: Type.Optional(writeProperties.title),
				kind: Type.Optional(StringEnum(offeredKinds)),
				...(nsh
					? {
							sourcePath: Type.Optional(
								Type.String({
									minLength: 1,
									maxLength: 4096,
									description: options.ask
										? "NSH only: one .tsx basename. Ask writes source there in this session's scratch/artifacts, then captures it."
										: "NSH only: one .tsx in this session's scratch/artifacts. Captured, never live-linked.",
								}),
							),
						}
					: {}),
				source: Type.Optional(
					options.ask
						? Type.String({
								maxLength: MAX_IMAGE_SOURCE_BYTES,
								description: nsh
									? "Image: an inline base64 image data URL (16 MiB decoded max), never a file path. NSH: the complete TSX file text (512 KiB UTF-8 max)."
									: "Image only: an inline base64 image data URL (16 MiB decoded max). File paths are not allowed in Ask.",
							})
						: writeProperties.source,
				),
				libraries: writeProperties.libraries,
				expectedRevision: Type.Optional(revisionNumber),
				revision: Type.Optional(revisionNumber),
			}),
			outputSchema: Type.Union([
				referenceSchema,
				Type.Object({
					artifact: Type.Object({
						...summaryProperties,
						source: Type.String(),
						libraries: Type.Array(library),
						libraryVersions: Type.Optional(Type.Record(Type.String(), Type.String())),
						data: Type.Optional(Type.Unknown()),
						visual: Type.Optional(Type.Object({ api: Type.Integer(), engine: Type.String() })),
						nsh: Type.Optional(
							Type.Object({
								api: Type.Literal(1),
								runtime: Type.Literal("nsh 0.5.0"),
								entry: Type.String(),
								sourceSha256: Type.String(),
								sourceBytes: Type.Integer(),
								rendering: Type.Literal("unsupported"),
							}),
						),
					}),
				}),
				Type.Object({ artifacts: Type.Array(Type.Object(summaryProperties)) }),
			]),
			async execute(_callId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<JsonValue>> {
				signal?.throwIfAborted();
				const { action, id } = params;
				// Check forged/old calls before touching storage or any image file loader.
				if (
					["create", "update", "preview"].includes(action) &&
					params.kind !== undefined &&
					!WRITE_KINDS.includes(params.kind)
				)
					throw new Error(
						`Artifact kind ${JSON.stringify(params.kind)} is read-only. Publish kind nsh or image instead; get still reads older artifacts.`,
					);
				if ((action as string) === "preview")
					throw new Error("Artifact preview is unavailable; publish without preview");
				if ((action === "get" || action === "update") && id === undefined)
					throw new Error(`Artifact ${action} requires id`);
				switch (action) {
					case "get": {
						let value: Omit<ArtifactRevision, "html"> | undefined;
						try {
							value = await store.get(id!, params.revision);
						} catch (error) {
							if (!(error instanceof ArtifactNotFound)) throw error;
						}
						if (!value) value = await options.readReference?.(id!, params.revision);
						signal?.throwIfAborted();
						if (!value) throw new Error(`Artifact not found: ${id}`);
						return dataResult({
							artifact: {
								...summary(value),
								source: value.source,
								libraries: value.libraries,
								...(value.libraryVersions ? { libraryVersions: { ...value.libraryVersions } } : {}),
								...(value.data !== undefined ? { data: value.data } : {}),
								...(value.visual ? { visual: { api: value.visual.api, engine: value.visual.engine } } : {}),
								...(value.nsh ? { nsh: { ...value.nsh } } : {}),
							},
						});
					}
					case "list":
						return dataResult({ artifacts: (await store.list()).map(summary) });
					case "create":
					case "update": {
						const { title, kind, source, libraries } = params;
						if (kind === "nsh" && !nsh) throw new Error("NSH file capture is unavailable in this session");
						if (kind !== "nsh" && "sourcePath" in params) throw new Error("Only NSH artifacts take sourcePath");
						if (title === undefined || kind === undefined || (source === undefined && kind !== "nsh"))
							throw new Error(`Artifact ${action} requires title, kind and source`);
						if (libraries?.length) throw new Error("New artifacts do not use libraries");
						const write: ArtifactWrite = {
							title,
							kind,
							source: source ?? "",
							...(libraries === undefined ? {} : { libraries: [] }),
						};
						if (kind === "nsh") {
							if (
								typeof params.sourcePath !== "string" ||
								(options.ask ? source === undefined : source !== undefined)
							)
								throw new Error(
									options.ask
										? "Ask NSH artifacts require source (the TSX text) and sourcePath"
										: "NSH artifacts require sourcePath only, not source",
								);
							if (action === "update" && params.expectedRevision === undefined)
								throw new Error("NSH updates require expectedRevision");
							// The only Ask file write: one .tsx in this session's own scratch/artifacts, never the project.
							if (options.ask)
								await writeNshScratchSource(options.nshSessionDirectory!, params.sourcePath, source!, signal);
							const captured = options.captureNsh
								? await options.captureNsh(params.sourcePath, signal)
								: await captureNshSource(options.nshSessionDirectory!, params.sourcePath, signal);
							write.source = captured.source;
							write.entry = captured.entry;
							signal?.throwIfAborted();
						}
						if (write.kind === "image") {
							// Check before any filesystem image loader, including forged direct/nested calls.
							if (options.ask && !write.source.startsWith("data:image/"))
								throw new Error("Ask image artifacts require inline data URLs, not file paths");
							if (write.libraries?.length) throw new Error("Image artifacts do not use libraries");
							write.source = await loadArtifactImage(write.source, ctx.cwd);
							signal?.throwIfAborted();
						}
						checkSource(write);

						if (action === "create") {
							const value = await store.create(write, signal);
							return published(
								value,
								write.kind === "nsh"
									? ["Source compiled and saved. Preview availability depends on your app."]
									: [],
							);
						}
						const value = await store.update(id!, write, params.expectedRevision, signal);
						const warnings: string[] =
							write.kind === "nsh"
								? ["Source compiled and saved. Preview availability depends on your app."]
								: [];
						if (params.expectedRevision === undefined)
							warnings.unshift(
								`Updated without expectedRevision, so a concurrent change could have been replaced. Pass expectedRevision (${value.revision}) next time.`,
							);
						return published(value, warnings);
					}
					default:
						throw new Error(`Unknown artifact action: ${action}`);
				}
			},
		}),
	];
}
