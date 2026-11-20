/** Pi SDK tools for publishing and inspecting session-local, offline artifacts. */
import type { JsonValue } from "@earendil-works/chord/json";
import { type AgentToolResult, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	ArtifactNotFound,
	type ArtifactStore,
	captureNshSource,
	imageSize,
	isArtifactKind,
	loadArtifactImage,
	MAX_IMAGE_BYTES,
	MAX_IMAGE_SOURCE_BYTES,
	NSH_SOURCE_BYTES,
	type NshRendered,
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
import { StringEnum } from "../schema.ts";

const NSH_LIMIT = `${NSH_SOURCE_BYTES / 1024} KiB UTF-8`;
const IMAGE_LIMIT = `${MAX_IMAGE_BYTES / 1024 / 1024} MiB decoded`;
const kind = StringEnum(["image", "nsh"] as const);
const writeProperties = {
	title: Type.String({ minLength: 1, maxLength: 160, description: "Short human-readable artifact title." }),
	source: Type.String({
		maxLength: MAX_IMAGE_SOURCE_BYTES,
		description: `Image only: a local file path or base64 image data URL (${IMAGE_LIMIT} max).`,
	}),
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
	preview: Type.Optional(Type.String()),
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
	/** Host-owned capture+compile+preview-run binding, never an executable/path selected by an artifact request. */
	captureNsh?: (
		sourcePath: string,
		signal?: AbortSignal,
	) => Promise<{ source: string; entry: string; rendered?: NshRendered }>;
}

function checkSource(write: ArtifactWrite): void {
	if (write.kind !== "image" && Buffer.byteLength(write.source, "utf8") > NSH_SOURCE_BYTES)
		throw new Error(`Artifact source exceeds the ${NSH_LIMIT} limit`);
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

const quote = (texts: string[]) => texts.map((text) => JSON.stringify(text)).join(", ");

/** What the publish-time preview run showed, for the agent. Problems go in warnings so they stand out. */
function previewReport(rendered: NshRendered | undefined): { preview: string; warnings: string[] } {
	if (!rendered) return { preview: "Source compiled and saved. The preview did not run.", warnings: [] };
	const warnings: string[] = [];
	if (rendered.noRoomCount)
		warnings.push(
			`${rendered.noRoomCount} texts have no room and do not show, such as ${quote(rendered.noRoom)}. A parent that clips has no height: often a Scroll or flex-1 inside Page. Fix it and update.`,
		);
	if (!rendered.texts && !rendered.noRoomCount) warnings.push("The preview shows no text.");
	const more = rendered.texts > rendered.shows.length ? ", …" : "";
	const pressed = rendered.pressed
		? ` Pressed ${rendered.pressed} variant switches (Choices options and tabs) once each with no errors.`
		: "";
	const unpressed = rendered.unpressed
		? ` ${rendered.unpressed} more were not pressed: the check ran out of time.`
		: "";
	return {
		preview: `Ran once like Day's preview (900×650, headless) with no errors. The first screen shows ${rendered.texts} texts${rendered.texts ? `: ${quote(rendered.shows)}${more}` : ""}.${pressed}${unpressed} This checks errors and layout, not looks.`,
		warnings,
	};
}

/** Register through createAgentSession(customTools), so codemode and extension hooks see these tools. */
export function createArtifactTools(options: ArtifactToolOptions): ToolDefinition[] {
	const { store } = options;
	const nsh = !!options.nshSessionDirectory;
	const scratch = JSON.stringify(`${options.nshSessionDirectory}/scratch/artifacts`);
	const offeredKinds: ArtifactWrite["kind"][] = nsh ? ["image", "nsh"] : ["image"];
	const actions = ["create", "update", "get", "list"] as const;
	const published = async (value: ArtifactRevision, warnings: string[] = [], preview?: string) => {
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
		return dataResult({
			artifact,
			...(warnings.length ? { warnings } : {}),
			...(preview === undefined ? {} : { preview }),
		});
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
Publish kind ${nsh ? "nsh or image" : "image"}.
${nsh ? `NSH: ${options.ask ? `pass the complete TSX as source and a .tsx basename as sourcePath; the tool writes that one file in ${scratch}, then captures it. Ask writes nothing else.` : `kind nsh captures one sourcePath (.tsx basename or absolute path in ${scratch}). Do not pass inline source.`} The tool compiles it and runs it once headless like Day's preview: errors publish nothing (fix and retry), and the result says what it shows. Not a full TypeScript typecheck. Saved UTF-8 bytes are immutable and survive scratch cleanup. No local/remote imports or assets are loaded. Source: ${NSH_LIMIT} max.\n` : ""}Images: ${IMAGE_LIMIT} max. ${options.ask ? "Ask images accept only inline base64 data:image/... URLs, never file paths." : "Pass a local PNG, JPEG, GIF or WebP path or an inline data URL, never a remote URL."}
Get the current source before updating, and pass its revision as expectedRevision.`,
			promptSnippet: nsh
				? "Publish NSH or image artifacts; inspect saved source"
				: "Publish image artifacts; inspect saved source",
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
									? `Image: an inline base64 image data URL (${IMAGE_LIMIT} max), never a file path. NSH: the complete TSX file text (${NSH_LIMIT} max).`
									: `Image only: an inline base64 image data URL (${IMAGE_LIMIT} max). File paths are not allowed in Ask.`,
							})
						: writeProperties.source,
				),
				expectedRevision: Type.Optional(revisionNumber),
				revision: Type.Optional(revisionNumber),
			}),
			outputSchema: Type.Union([
				referenceSchema,
				Type.Object({
					artifact: Type.Object({
						...summaryProperties,
						source: Type.String(),
						nsh: Type.Optional(
							Type.Object({
								api: Type.Literal(1),
								runtime: Type.String(),
								entry: Type.String(),
								sourceSha256: Type.String(),
								sourceBytes: Type.Integer(),
								rendering: Type.Optional(Type.Literal("unsupported")),
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
					!isArtifactKind(params.kind)
				)
					throw new Error(`Unsupported artifact kind. Publish kind ${nsh ? "nsh or image" : "image"}.`);
				if ((action as string) === "preview")
					throw new Error("There is no preview action: create and update run the preview and say what it shows");
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
						if (!value || !isArtifactKind(value.kind)) throw new Error(`Artifact not found: ${id}`);
						return dataResult({
							artifact: {
								...summary(value),
								source: value.source,
								...(value.nsh ? { nsh: { ...value.nsh } } : {}),
							},
						});
					}
					case "list":
						return dataResult({
							artifacts: (await store.list()).filter((item) => isArtifactKind(item.kind)).map(summary),
						});
					case "create":
					case "update": {
						const { title, kind, source } = params;
						if (kind === "nsh" && !nsh) throw new Error("NSH file capture is unavailable in this session");
						if (kind !== "nsh" && "sourcePath" in params) throw new Error("Only NSH artifacts take sourcePath");
						if (title === undefined || kind === undefined || (source === undefined && kind !== "nsh"))
							throw new Error(`Artifact ${action} requires title, kind and source`);
						const write: ArtifactWrite = {
							title,
							kind,
							source: source ?? "",
						};
						let report: ReturnType<typeof previewReport> | undefined;
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
							report = previewReport(captured.rendered);
							signal?.throwIfAborted();
						}
						if (write.kind === "image") {
							// Check before any filesystem image loader, including forged direct/nested calls.
							if (options.ask && !write.source.startsWith("data:image/"))
								throw new Error("Ask image artifacts require inline data URLs, not file paths");
							write.source = await loadArtifactImage(write.source, ctx.cwd);
							signal?.throwIfAborted();
						}
						checkSource(write);

						if (action === "create") {
							const value = await store.create(write, signal);
							return published(value, report?.warnings, report?.preview);
						}
						const value = await store.update(id!, write, params.expectedRevision, signal);
						const warnings = [...(report?.warnings ?? [])];
						if (params.expectedRevision === undefined)
							warnings.unshift(
								`Updated without expectedRevision, so a concurrent change could have been replaced. Pass expectedRevision (${value.revision}) next time.`,
							);
						return published(value, warnings, report?.preview);
					}
					default:
						throw new Error(`Unknown artifact action: ${action}`);
				}
			},
		}),
	];
}
