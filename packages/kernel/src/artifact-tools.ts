/** Pi SDK tools for publishing and inspecting session-local, offline artifacts. */
import type { JsonValue } from "@earendil-works/chord";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { type AgentToolResult, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	type ArtifactStore,
	isArtifactPreviewAvailable,
	loadArtifactImage,
	MAX_IMAGE_SOURCE_BYTES,
	previewArtifact,
} from "@pilot/artifacts";
import type { ArtifactReference, ArtifactRevision, ArtifactSummary, ArtifactWrite } from "@pilot/protocol";
import { ARTIFACT_SKILL_PATH } from "./artifact-skill.ts";

const MAX_SOURCE_BYTES = 512 * 1024;
const library = StringEnum(["react", "react-dom", "mermaid", "echarts", "motion", "d3", "three"] as const);
const kind = StringEnum(["html", "react", "image", "swiftui"] as const);
const writeProperties = {
	title: Type.String({ minLength: 1, maxLength: 160, description: "Short human-readable artifact title." }),
	kind,
	source: Type.String({
		maxLength: MAX_IMAGE_SOURCE_BYTES,
		description:
			"HTML, JSX/TSX or standalone SwiftUI (512 KiB UTF-8 max), or for image: a local file path or base64 image data URL (16 MiB decoded max).",
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
});
const revisionNumber = Type.Integer({ minimum: 1 });
const diagnosticsProperties = {
	consoleMessages: Type.Array(Type.Object({ level: Type.String(), text: Type.String() })),
	contentHeight: Type.Number(),
};

export interface ArtifactToolOptions {
	store: Pick<ArtifactStore, "create" | "update" | "get" | "list">;
	/** Persist a display-only transcript reference, including publications nested inside codemode. */
	onArtifactPublished?: (artifact: ArtifactReference) => Promise<void>;
	onArtifactsChanged?: () => void;
	/** Override the renderer for tests, or disable preview. By default, require an installed renderer. */
	preview?: typeof previewArtifact | false;
	/** Ask permits session-local artifacts and sandboxed previews, but never arbitrary image-path reads. */
	ask?: boolean;
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
	const preview =
		options.preview === false
			? undefined
			: (options.preview ?? (isArtifactPreviewAvailable() ? previewArtifact : undefined));
	const actions = ["create", "update", "get", "list", ...(preview ? ["preview" as const] : [])] as const;
	const previewDescription = preview
		? "- preview: optionally render a draft without saving; returns screenshot and diagnostics. Preview is not required before publishing. If it fails, publish without preview.\n"
		: "";
	const published = async (value: ArtifactRevision) => {
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
		return dataResult({ artifact });
	};
	return [
		defineTool({
			name: "artifact",
			label: "Artifact",
			namespace: {
				name: "artifacts",
				description:
					"Publish and inspect HTML, React, images and SwiftUI with tools.artifact. Read the pilot-artifacts skill before authoring.",
				instructions: `Read the bundled pilot-artifacts skill at ${ARTIFACT_SKILL_PATH} before authoring.`,
			},
			description: `Publish and inspect session-local offline artifacts. Read the pilot-artifacts skill before authoring.
- create: publish title, kind, source and optional libraries; returns a compact pinned reference.
- update: replace the complete document by id, not a patch; expectedRevision rejects stale updates.
- get: read editable source and metadata by id, optionally at a historical revision; omitting revision reads latest.
- list: list current session summaries without source.
${previewDescription}Source must be self-contained and offline. Text source: 512 KiB UTF-8 max; images: 16 MiB decoded max.
${options.ask ? "Ask images accept only inline base64 data:image/... URLs, never file paths." : "Images accept local PNG, JPEG, GIF or WebP paths, or inline data URLs; never remote URLs."}
SwiftUI requires the macOS Swift toolchain and renders a static screenshot, not project views. Publication does not require the Pilot app to be running.
Get the current source before updating, and pass its revision as expectedRevision.`,
			promptSnippet: "Publish and inspect offline HTML, React, image or native SwiftUI artifacts",
			executionMode: "sequential",
			annotations: { openWorldHint: false, destructiveHint: false },
			parameters: Type.Object({
				action: StringEnum(actions),
				id: Type.Optional(Type.String({ description: "Artifact ID, required for get and update." })),
				title: Type.Optional(writeProperties.title),
				kind: Type.Optional(kind),
				source: Type.Optional(
					options.ask
						? Type.String({
								maxLength: MAX_IMAGE_SOURCE_BYTES,
								description:
									"HTML, JSX/TSX or standalone SwiftUI (512 KiB UTF-8 max), or inline base64 image data URL (16 MiB decoded max). Image file paths are not allowed in Ask.",
							})
						: writeProperties.source,
				),
				libraries: writeProperties.libraries,
				expectedRevision: Type.Optional(revisionNumber),
				revision: Type.Optional(revisionNumber),
				...(preview
					? {
							width: Type.Optional(
								Type.Integer({
									minimum: 240,
									maximum: 1600,
									description: "Preview width in CSS pixels, default 800.",
								}),
							),
							height: Type.Optional(
								Type.Integer({
									minimum: 200,
									maximum: 1600,
									description: "Preview height in CSS pixels, default 600.",
								}),
							),
						}
					: {}),
			}),
			outputSchema: Type.Union([
				referenceSchema,
				Type.Object({
					artifact: Type.Object({ ...summaryProperties, source: Type.String(), libraries: Type.Array(library) }),
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
						const value = await store.get(id!, params.revision);
						if (!value) throw new Error(`Artifact not found: ${id}`);
						return dataResult({
							artifact: { ...summary(value), source: value.source, libraries: value.libraries },
						});
					}
					case "list":
						return dataResult({ artifacts: (await store.list()).map(summary) });
					case "create":
					case "update":
					case "preview": {
						const { title, kind, source, libraries } = params;
						if (title === undefined || kind === undefined || source === undefined)
							throw new Error(`Artifact ${action} requires title, kind and source`);
						const write: ArtifactWrite = {
							title,
							kind,
							source,
							...(libraries === undefined ? {} : { libraries }),
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
						if (action === "create") return published(await store.create(write, signal));
						if (action === "update")
							return published(await store.update(id!, write, params.expectedRevision, signal));
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
