/** Pi SDK tools for publishing and inspecting session-local, offline artifacts. */
import type { JsonValue } from "@earendil-works/chord";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { type AgentToolResult, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	ArtifactNotFound,
	type ArtifactStore,
	isBrowserPreviewAvailable,
	isArtifactPreviewAvailable,
	loadArtifactImage,
	MAX_IMAGE_SOURCE_BYTES,
	previewArtifact,
} from "@pilot/artifacts";
import type {
	ArtifactData,
	ArtifactReference,
	ArtifactRevision,
	ArtifactSummary,
	ArtifactWrite,
} from "@pilot/protocol";
import { ARTIFACT_SKILL_PATH } from "./artifact-skill.ts";

const MAX_SOURCE_BYTES = 512 * 1024;
const library = StringEnum(["react", "react-dom", "mermaid", "echarts", "motion", "d3", "three"] as const);
const kind = StringEnum(["html", "react", "image", "swiftui", "shader", "visual"] as const);
const writeKind = StringEnum(["html", "react", "image", "swiftui", "shader"] as const);
const visualWriteKind = kind;
const writeProperties = {
	title: Type.String({ minLength: 1, maxLength: 160, description: "Short human-readable artifact title." }),
	kind,
	source: Type.String({
		maxLength: MAX_IMAGE_SOURCE_BYTES,
		description:
			"HTML, JSX/TSX, GLSL mainImage or standalone SwiftUI (512 KiB UTF-8 max), or for image: a local file path or base64 image data URL (16 MiB decoded max).",
	}),
	libraries: Type.Optional(
		Type.Array(library, { description: "Offline libraries to include, especially for HTML script globals." }),
	),
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
			logs: Type.Optional(Type.Array(Type.String())),
		}),
	),
});
const revisionNumber = Type.Integer({ minimum: 1 });
const diagnosticsProperties = {
	consoleMessages: Type.Array(Type.Object({ level: Type.String(), text: Type.String() })),
	contentHeight: Type.Number(),
};

export interface ArtifactToolOptions {
	store: Pick<ArtifactStore, "create" | "update" | "get" | "list">;
	/** Read-only daemon lookup for references linked to the caller's current mission. */
	readReference?: (id: string, revision?: number) => Promise<Omit<ArtifactRevision, "html"> | undefined>;
	/** Persist a display-only transcript reference, including publications nested inside codemode. */
	onArtifactPublished?: (artifact: ArtifactReference) => Promise<void>;
	onArtifactsChanged?: () => void;
	/** Override the renderer for tests, or disable preview. By default, require an installed renderer. */
	preview?: typeof previewArtifact | false;
	/** Ask permits session-local artifacts and sandboxed previews, but never arbitrary image-path reads. */
	ask?: boolean;
	/** After publishing HTML/React/shaders, render once to report runtime errors as non-blocking warnings.
	 * Defaults to the installed browser renderer; tests inject or disable it. */
	diagnose?: ArtifactDiagnose | false;
	/** Offer kind "visual" (native visuals). Off until the app renders them; PILOT_VISUAL_ARTIFACTS=1 turns it on. */
	visuals?: boolean;
}

export type ArtifactDiagnose = (write: ArtifactWrite, signal?: AbortSignal) => Promise<string[]>;

const DIAGNOSE_TIMEOUT_MS = 10_000;
const MAX_WARNINGS = 10;

/** Smoke render with the shared warm browser. Diagnostics never fail or block a publication. */
export const diagnoseArtifact: ArtifactDiagnose = async (write, signal) => {
	const result = await previewArtifact(write, { signal, timeoutMs: DIAGNOSE_TIMEOUT_MS });
	return result.consoleMessages
		.filter((message) => message.level === "error")
		.slice(0, MAX_WARNINGS)
		.map((message) => `Runtime error: ${message.text.slice(0, 500)}`);
};

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
	const visuals = options.visuals ?? process.env.PILOT_VISUAL_ARTIFACTS === "1";
	const preview =
		options.preview === false
			? undefined
			: (options.preview ?? (isArtifactPreviewAvailable() ? previewArtifact : undefined));
	const diagnose =
		options.diagnose === false
			? undefined
			: (options.diagnose ?? (isBrowserPreviewAvailable() ? diagnoseArtifact : undefined));
	const actions = ["create", "update", "get", "list", ...(preview ? ["preview" as const] : [])] as const;
	const previewDescription = preview
		? "- preview: optionally render a draft without saving; returns screenshot and diagnostics. Preview is not required before publishing. If it fails, publish without preview.\n"
		: "";
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
			await options.onArtifactPublished?.(artifact);
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
					...(value.visual.check.logs.length ? { logs: [...value.visual.check.logs] } : {}),
				}
			: undefined;
		return dataResult({ artifact, ...(warnings.length ? { warnings } : {}), ...(check ? { check } : {}) });
	};
	const runtimeWarnings = async (write: ArtifactWrite, signal?: AbortSignal): Promise<string[]> => {
		if (!diagnose || write.kind === "image" || write.kind === "swiftui" || write.kind === "visual") return [];
		try {
			const warnings = await diagnose(write, signal);
			return warnings.length
				? [...warnings, "The artifact was published. Fix these errors with update if they affect the result."]
				: [];
		} catch {
			// A missing, slow or crashed renderer says nothing about the artifact itself.
			return [];
		}
	};
	return [
		defineTool({
			name: "artifact",
			label: "Artifact",
			namespace: {
				name: "artifacts",
				description:
					"Publish and inspect HTML, React, shaders, images and SwiftUI with tools.artifact. Read the pilot-artifacts skill before authoring.",
				instructions: `Read the bundled pilot-artifacts skill at ${ARTIFACT_SKILL_PATH} before authoring.`,
			},
			description: `Publish and inspect session-local offline artifacts. Read the pilot-artifacts skill before authoring.
- create: publish title, kind, source and optional libraries; returns a compact pinned reference.
- update: replace the complete document by id, not a patch; expectedRevision rejects stale updates.
- get: read source and metadata by id, optionally at a historical revision. Local artifacts read latest when revision is omitted. Linked mission/task references are read-only: omission uses the pinned revision, or latest for unpinned links; conflicting pins require an explicit linked revision.
- list: list current session summaries without source.
${previewDescription}Source must be self-contained and offline. Text source: 512 KiB UTF-8 max; images: 16 MiB decoded max.
${options.ask ? "Ask images accept only inline base64 data:image/... URLs, never file paths." : "Images accept local PNG, JPEG, GIF or WebP paths, or inline data URLs; never remote URLs."}
SwiftUI requires the macOS Swift toolchain and renders a static screenshot, not project views. Publication does not require the Pilot app to be running.
Shaders are Shadertoy-style GLSL (mainImage); publication fails with line-numbered compile errors.
${visuals ? "Visuals: kind visual, source String(fn) of a function ({ ui, state, data }) => view, data any JSON (1 MiB). Publication runs it and fails with line-numbered errors.\n" : ""}Get the current source before updating, and pass its revision as expectedRevision.`,
			promptSnippet: "Publish and inspect offline HTML, React, shader, image or native SwiftUI artifacts",
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
									"HTML, JSX/TSX, GLSL mainImage or standalone SwiftUI (512 KiB UTF-8 max), or inline base64 image data URL (16 MiB decoded max). Image file paths are not allowed in Ask.",
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
				...(preview
					? {
							width: Type.Optional(
								Type.Integer({
									minimum: 240,
									maximum: 1600,
									description: "Preview width in logical pixels, default 800 (SwiftUI layout ceiling: 760).",
								}),
							),
							height: Type.Optional(
								Type.Integer({
									minimum: 200,
									maximum: 1600,
									description: "Preview height in logical pixels, default 600 (SwiftUI layout ceiling: 1600).",
								}),
							),
						}
					: {}),
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
				...(preview
					? [
							Type.Object({
								screenshot: Type.Object({
									mimeType: Type.Literal("image/png"),
									data: Type.String(),
									width: Type.Number(),
									height: Type.Number(),
								}),
								...diagnosticsProperties,
							}),
						]
					: []),
			]),
			async execute(_callId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<JsonValue>> {
				signal?.throwIfAborted();
				const { action, id } = params;
				if (action === "preview" && !preview)
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
					case "update":
					case "preview": {
						const { title, kind, source, libraries } = params;
						if (kind === "visual" && !visuals) throw new Error("Visual artifacts are not available yet");
						if (kind === "visual" && source === undefined)
							throw new Error(
								"Visual artifacts require source: String(visual). Tool arguments are JSON, so a function passed directly arrives empty",
							);
						if (title === undefined || kind === undefined || source === undefined)
							throw new Error(`Artifact ${action} requires title, kind and source`);
						if (kind === "visual" && action === "preview")
							throw new Error(
								"Preview does not render visuals. Publish with create: it runs the visual and reports errors with lines",
							);
						const write: ArtifactWrite = {
							title,
							kind,
							source,
							...(libraries === undefined ? {} : { libraries }),
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
						if (write.kind === "swiftui" && write.libraries?.length)
							throw new Error("SwiftUI artifacts do not use libraries");
						if (action === "create") {
							const value = await store.create(write, signal);
							return published(value, await runtimeWarnings(write, signal));
						}
						if (action === "update") {
							const value = await store.update(id!, write, params.expectedRevision, signal);
							const warnings = await runtimeWarnings(write, signal);
							if (params.expectedRevision === undefined)
								warnings.unshift(
									`Updated without expectedRevision, so a concurrent change could have been replaced. Pass expectedRevision (${value.revision}) next time.`,
								);
							return published(value, warnings);
						}
						const result = await preview!(write, {
							width: typeof params.width === "number" ? params.width : undefined,
							height: typeof params.height === "number" ? params.height : undefined,
							signal,
						});
						const diagnostics = { consoleMessages: result.consoleMessages, contentHeight: result.contentHeight };
						return {
							content: [
								{ type: "image", mimeType: result.screenshot.mimeType, data: result.screenshot.data },
								{ type: "text", text: JSON.stringify(diagnostics) },
							],
							details: diagnostics,
							structuredContent: {
								screenshot: { ...result.screenshot },
								consoleMessages: result.consoleMessages.map((message) => ({ ...message })),
								contentHeight: result.contentHeight,
							},
						};
					}
					default:
						throw new Error(`Unknown artifact action: ${action}`);
				}
			},
		}),
	];
}
