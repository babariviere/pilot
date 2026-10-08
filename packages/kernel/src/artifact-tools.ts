/** Pi SDK tools for publishing and inspecting session-local, offline artifacts. */
import type { JsonValue } from "@earendil-works/chord";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { type AgentToolResult, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	type ArtifactStore,
	artifactLibraries,
	isArtifactPreviewAvailable,
	loadArtifactImage,
	MAX_IMAGE_SOURCE_BYTES,
	previewArtifact,
} from "@pilot/artifacts";
import type { ArtifactReference, ArtifactRevision, ArtifactSummary, ArtifactWrite } from "@pilot/protocol";

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

const fileImageAuthoring = `Image: kind:"image", source is a local PNG, JPEG, GIF or WebP path (relative to the session working directory or absolute) or a base64 data:image/... URL. Maximum decoded image size is 16 MiB; libraries are not supported. The tool embeds the bytes durably, so the original file need not remain. No remote URLs. In codemode: await tools.artifact({action:"create",title:"Generated image",kind:"image",source:"/tmp/generated.png"}). Do not print image base64; get returns the saved data URL.`;
const inlineImageAuthoring = `Image: kind:"image" accepts only inline base64 data:image/... URLs containing PNG, JPEG, GIF or WebP bytes in Ask. Local file paths and remote URLs are not allowed. Maximum decoded image size is 16 MiB; libraries are not supported. In codemode, pass an existing inline data URL: await tools.artifact({action:"create",title:"Image",kind:"image",source:dataUrl}). Do not print image base64; get returns the saved data URL.`;
const authoring = (
	ask = false,
) => `HTML and React source must be self-contained and at most 512 KiB UTF-8. Runs offline in a sandbox: no CDN, remote scripts, fetch, network assets, Node APIs, native bridge or arbitrary npm imports. Tailwind is not available: use plain CSS inline or in <style> tags, not external stylesheets or assumed utility classes.
SwiftUI: kind:"swiftui", source is self-contained Swift defining struct ArtifactView: View with a zero-argument initializer. SwiftUI, AppKit and Foundation imports are provided. No project imports, package dependencies, @main or #Preview. Avoid @State (Command Line Tools lack its macro plugin); use @StateObject if needed. Maximum source is 512 KiB UTF-8; libraries are not supported. Requires macOS 14+ and installed Swift Command Line Tools (xcode-select --install), with no browser installation. Compiles and renders in a disposable sandbox with no network or workspace/credential access. Static screenshot only, not an interactive app or validation of actual project views. Offscreen ImageRenderer does not capture embedded AppKit/WebKit views; use SwiftUI layout primitives and inspect screenshots for unsupported controls. create/update save editable Swift source and an embedded 800x600 PNG. Compiler diagnostics are reported on failure. Cold SDK compilation can take minutes; do not set short codemode deadlines. SwiftUI example: {title:"Native card",kind:"swiftui",source:'struct ArtifactView: View { var body: some View { VStack(alignment: .leading) { Text("Preview").font(.title); Text("Native SwiftUI layout") }.padding(24) } }'}.
${ask ? inlineImageAuthoring : fileImageAuthoring}
Pilot supplies a light palette and system font. Use CSS variables --pilot-background, --pilot-foreground, --pilot-muted, --pilot-muted-foreground, --pilot-border, --pilot-primary and --pilot-radius for consistent styling; your styles may override them.
HTML: use inline CSS or <style> tags and ordinary inline <script> tags. Select libraries to get globals echarts, mermaid, motion, d3, THREE (three). Do not import packages in HTML scripts.
HTML example: {title:"Chart",kind:"html",libraries:["echarts"],source:'<div id="chart" style="height:320px"></div><script>echarts.init(document.getElementById("chart")).setOption({xAxis:{type:"category",data:["A","B"]},yAxis:{},series:[{type:"bar",data:[2,5]}]});</script>'}.
Mermaid example: libraries:["mermaid"], source:'<pre class="mermaid">graph TD; A-->B</pre><script>mermaid.initialize({startOnLoad:true});</script>'. Motion uses motion.animate(), D3 uses d3.select(), Three uses new THREE.Scene().
React: source is a JSX/TSX module with a default-export component. Allowed imports only: react, react-dom (including react-dom/client), mermaid, echarts, motion (including motion/react), and optional d3 or three. React and ReactDOM mounting are provided; do not mount the component yourself.
React example: {title:"Counter",kind:"react",source:'import {useState} from "react"; export default function App(){const [n,setN]=useState(0);return <button onClick={()=>setN(n+1)}>Count: {n}</button>}'}.
Available pinned offline libraries: ${JSON.stringify(artifactLibraries)}.
Update an existing artifact instead of creating duplicates; get its current editable source first and pass expectedRevision to avoid overwriting a newer revision.`;

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
		? '- preview: optionally render a draft to a PNG screenshot, consoleMessages and contentHeight without saving or publishing. Optional width/height set the viewport. HTML/React/image need installed Chromium; SwiftUI needs the installed macOS Swift toolchain, independently of Chromium. Preview is not required before publishing. If it fails, publish without preview; do not request a browser installation. SwiftUI publication also renders the source, so fix native compiler/render errors before publishing. In codemode: const r = await tools.artifact({action:"preview",...write}); image({type:"image",...r.screenshot}); text({consoleMessages:r.consoleMessages,contentHeight:r.contentHeight}); Do not print screenshot base64 as text.\n'
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
			description: `Publish and inspect session-local offline artifacts.
Actions:
- create: publish a new artifact with title, kind, source and optional libraries. Returns a compact pinned reference, not compiled HTML.
- update: publish a revision by id with the complete replacement title, kind, source and libraries, not a patch. Optional expectedRevision rejects stale updates. Returns a compact pinned reference.
- get: read editable source and metadata by id, optionally at a historical revision. Omitting revision reads the latest. Never returns compiled HTML. Use before updating and pass its revision as expectedRevision.
- list: list current session artifact summaries without source or compiled HTML.
${previewDescription}${authoring(options.ask)}`,
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
