/** Pi SDK tools for publishing and inspecting session-local, offline artifacts. */
import type { JsonValue } from "@earendil-works/chord";
import { type AgentToolResult, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	ArtifactNotFound,
	type ArtifactStore,
	assertArtifactWriteKind,
	imageSize,
	loadArtifactImage,
	MAX_IMAGE_SOURCE_BYTES,
} from "@pilot/artifacts";
import type {
	ArtifactData,
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
const kind = StringEnum(["html", "react", "image", "swiftui", "shader", "visual"] as const);
const writeKind = StringEnum(["image", "shader"] as const);
const visualWriteKind = StringEnum(["image", "shader", "visual"] as const);
const writeProperties = {
	title: Type.String({ minLength: 1, maxLength: 160, description: "Short human-readable artifact title." }),
	kind: visualWriteKind,
	source: Type.String({
		maxLength: MAX_IMAGE_SOURCE_BYTES,
		description:
			"Native visual source or GLSL mainImage (512 KiB UTF-8 max), or for image: a local file path or base64 image data URL (16 MiB decoded max).",
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
	check: Type.Optional(
		Type.Object({
			nodes: Type.Integer(),
			controls: Type.Integer(),
			interactions: Type.Integer(),
			draws: Type.Optional(Type.Integer()),
			shaders: Type.Optional(Type.Integer()),
			mermaid: Type.Optional(Type.Integer()),
			logs: Type.Optional(Type.Array(Type.String())),
		}),
	),
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
	/** Offer kind "visual" (native visuals), which the app renders. On by default; PILOT_VISUAL_ARTIFACTS=0 hides it. */
	visuals?: boolean;
}

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
	const visuals = options.visuals ?? process.env.PILOT_VISUAL_ARTIFACTS !== "0";
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
		const check = value.visual
			? {
					nodes: value.visual.check.nodes,
					controls: value.visual.check.controls,
					interactions: value.visual.check.interactions,
					...(value.visual.check.draws ? { draws: value.visual.check.draws } : {}),
					...(value.visual.check.shaders ? { shaders: value.visual.check.shaders } : {}),
					...(value.visual.check.mermaid ? { mermaid: value.visual.check.mermaid } : {}),
					...(value.visual.check.logs.length ? { logs: [...value.visual.check.logs] } : {}),
				}
			: undefined;
		return dataResult({ artifact, ...(warnings.length ? { warnings } : {}), ...(check ? { check } : {}) });
	};
	return [
		defineTool({
			name: "artifact",
			label: "Artifact",
			namespace: {
				name: "artifacts",
				description: `Publish and inspect ${visuals ? "native visuals, " : ""}images and shaders with tools.artifact. Read the pilot-artifacts skill before creating or updating artifacts.`,
				instructions: `Read the bundled pilot-artifacts skill at ${ARTIFACT_SKILL_PATH} before creating or updating artifacts.`,
			},
			description: `Publish and inspect session-local offline artifacts. Read the pilot-artifacts skill before creating or updating artifacts.
- create: publish title, kind and source; returns a compact pinned reference.
- update: replace the complete document by id, not a patch; expectedRevision rejects stale updates.
- get: read source and metadata by id, optionally at a historical revision. Local artifacts read latest when revision is omitted. Linked mission/task references are read-only: omission uses the pinned revision, or latest for unpinned links; conflicting pins require an explicit linked revision.
- list: list current session summaries without source.
Source must be self-contained and offline. Text source: 512 KiB UTF-8 max; images: 16 MiB decoded max.
${options.ask ? "Ask images accept only inline base64 data:image/... URLs, never file paths." : "Images accept local PNG, JPEG, GIF or WebP paths, or inline data URLs; never remote URLs."}
HTML, React and SwiftUI are read-only historical kinds, not supported for publication or preview.
Shaders are Shadertoy-style GLSL (mainImage); publication fails with line-numbered compile errors.
${visuals ? "Visuals (kind visual) come first for charts, stats, tables, controls, Mermaid diagrams, canvas and shaders: source String(fn) of ({ ui, state, data }) => view, data any JSON (1 MiB). Publication fails with line-numbered errors; fix and republish.\n" : ""}Get the current source before updating, and pass its revision as expectedRevision.`,
			promptSnippet: visuals
				? "Publish native visuals or images; inspect historical artifact sources"
				: "Publish images or shaders; inspect historical artifact sources",
			executionMode: "sequential",
			annotations: { openWorldHint: false, destructiveHint: false },
			parameters: Type.Object({
				action: StringEnum(actions),
				id: Type.Optional(Type.String({ description: "Artifact ID, required for get and update." })),
				title: Type.Optional(writeProperties.title),
				kind: Type.Optional(visuals ? visualWriteKind : writeKind),
				source: Type.Optional(
					options.ask
						? Type.String({
								maxLength: MAX_IMAGE_SOURCE_BYTES,
								description:
									"Native visual source or GLSL mainImage (512 KiB UTF-8 max), or inline base64 image data URL (16 MiB decoded max). Image file paths are not allowed in Ask.",
							})
						: writeProperties.source,
				),
				libraries: writeProperties.libraries,
				...(visuals
					? {
							data: Type.Optional(
								Type.Unknown({ description: "Visuals only: JSON passed to the function as data (1 MiB max)." }),
							),
						}
					: {}),
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
					}),
				}),
				Type.Object({ artifacts: Type.Array(Type.Object(summaryProperties)) }),
			]),
			async execute(_callId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<JsonValue>> {
				signal?.throwIfAborted();
				const { action, id } = params;
				// Check forged/old calls before touching storage or any image file loader.
				if (["create", "update", "preview"].includes(action) && params.kind !== undefined)
					assertArtifactWriteKind(params.kind);
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
							},
						});
					}
					case "list":
						return dataResult({ artifacts: (await store.list()).map(summary) });
					case "create":
					case "update": {
						const { title, kind, source, libraries } = params;
						if (kind === "visual" && !visuals) throw new Error("Visual artifacts are not available yet");
						if (kind === "visual" && source === undefined)
							throw new Error(
								"Visual artifacts require source: String(visual). Tool arguments are JSON, so a function passed directly arrives empty",
							);
						if (title === undefined || kind === undefined || source === undefined)
							throw new Error(`Artifact ${action} requires title, kind and source`);
						if (libraries?.length) throw new Error("New artifacts do not use libraries");
						const write: ArtifactWrite = {
							title,
							kind,
							source,
							...(libraries === undefined ? {} : { libraries: [] }),
							...("data" in params && params.data !== undefined ? { data: params.data as ArtifactData } : {}),
						};
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
							return published(value);
						}
						const value = await store.update(id!, write, params.expectedRevision, signal);
						const warnings: string[] = [];
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
