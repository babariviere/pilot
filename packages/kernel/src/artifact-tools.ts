/** Pi SDK tools for publishing and inspecting session-local, offline artifacts. */
import type { JsonValue } from "@earendil-works/chord";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { type AgentToolResult, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type ArtifactStore, artifactLibraries, previewArtifact } from "@pilot/artifacts";
import type { ArtifactReference, ArtifactRevision, ArtifactSummary, ArtifactWrite } from "@pilot/protocol";

const MAX_SOURCE_BYTES = 512 * 1024;
const library = StringEnum(["react", "react-dom", "mermaid", "echarts", "motion", "d3", "three"] as const);
const kind = StringEnum(["html", "react"] as const);
const writeProperties = {
	title: Type.String({ minLength: 1, maxLength: 160, description: "Short human-readable artifact title." }),
	kind,
	source: Type.String({
		maxLength: MAX_SOURCE_BYTES,
		description: "Editable HTML or default-export JSX/TSX source, at most 512 KiB UTF-8.",
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

const authoring = `Source must be self-contained and at most 512 KiB UTF-8. Runs offline in a sandbox: no CDN, remote scripts, fetch, network assets, Node APIs, native bridge or arbitrary npm imports. Tailwind is not available: use plain CSS inline or in <style> tags, not external stylesheets or assumed utility classes.
Pilot supplies a light palette and system font. Use CSS variables --pilot-background, --pilot-foreground, --pilot-muted, --pilot-muted-foreground, --pilot-border, --pilot-primary and --pilot-radius for consistent styling; your styles may override them.
HTML: use inline CSS or <style> tags and ordinary inline <script> tags. Select libraries to get globals echarts, mermaid, motion, d3, THREE (three). Do not import packages in HTML scripts.
HTML example: {title:"Chart",kind:"html",libraries:["echarts"],source:'<div id="chart" style="height:320px"></div><script>echarts.init(document.getElementById("chart")).setOption({xAxis:{type:"category",data:["A","B"]},yAxis:{},series:[{type:"bar",data:[2,5]}]});</script>'}.
Mermaid example: libraries:["mermaid"], source:'<pre class="mermaid">graph TD; A-->B</pre><script>mermaid.initialize({startOnLoad:true});</script>'. Motion uses motion.animate(), D3 uses d3.select(), Three uses new THREE.Scene().
React: source is a JSX/TSX module with a default-export component. Allowed imports only: react, react-dom (including react-dom/client), mermaid, echarts, motion (including motion/react), and optional d3 or three. React and ReactDOM mounting are provided; do not mount the component yourself.
React example: {title:"Counter",kind:"react",source:'import {useState} from "react"; export default function App(){const [n,setN]=useState(0);return <button onClick={()=>setN(n+1)}>Count: {n}</button>}'}.
Available pinned offline libraries: ${JSON.stringify(artifactLibraries)}.
Use artifact_preview to inspect screenshots and diagnostics before publishing. Update an existing artifact instead of creating duplicates; get its current editable source first and pass expectedRevision to avoid overwriting a newer revision.`;

export interface ArtifactToolOptions {
	store: Pick<ArtifactStore, "create" | "update" | "get" | "list">;
	/** Persist a display-only transcript reference, including publications nested inside codemode. */
	onArtifactPublished?: (artifact: ArtifactReference) => Promise<void>;
	onArtifactsChanged?: () => void;
	/** Allows tool tests to avoid launching a browser. */
	preview?: typeof previewArtifact;
}

function checkSource(write: ArtifactWrite): void {
	if (Buffer.byteLength(write.source, "utf8") > MAX_SOURCE_BYTES)
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
	const common = {
		executionMode: "sequential" as const,
		annotations: { openWorldHint: false, destructiveHint: false },
	};
	return [
		defineTool({
			...common,
			name: "artifact_create",
			label: "Create artifact",
			description: `Publish a new versioned HTML or React artifact in this Pilot session. Returns a compact artifact reference, not compiled HTML. ${authoring}`,
			promptSnippet: "Publish an offline HTML or React artifact",
			parameters: Type.Object(writeProperties),
			outputSchema: referenceSchema,
			async execute(_id, write, signal) {
				signal?.throwIfAborted();
				checkSource(write);
				return published(await store.create(write));
			},
		}),
		defineTool({
			...common,
			name: "artifact_update",
			label: "Update artifact",
			description: `Publish a new revision of an existing artifact. Supply the complete replacement title, kind, source and libraries, not a patch. expectedRevision rejects stale updates. Returns a compact artifact reference. ${authoring}`,
			parameters: Type.Object({
				id: Type.String(),
				...writeProperties,
				expectedRevision: Type.Optional(revisionNumber),
			}),
			outputSchema: referenceSchema,
			async execute(_callId, { id, expectedRevision, ...write }, signal) {
				signal?.throwIfAborted();
				checkSource(write);
				return published(await store.update(id, write, expectedRevision));
			},
		}),
		defineTool({
			...common,
			name: "artifact_get",
			label: "Get artifact",
			description:
				"Get editable artifact source and metadata by ID, optionally at a historical revision. Omitting revision reads the latest. Never returns compiled HTML. Use this before updating and pass its revision as expectedRevision.",
			annotations: { ...common.annotations, readOnlyHint: true },
			parameters: Type.Object({ id: Type.String(), revision: Type.Optional(revisionNumber) }),
			outputSchema: Type.Object({
				artifact: Type.Object({ ...summaryProperties, source: Type.String(), libraries: Type.Array(library) }),
			}),
			async execute(_callId, { id, revision }, signal) {
				signal?.throwIfAborted();
				const value = await store.get(id, revision);
				if (!value) throw new Error(`Artifact not found: ${id}`);
				return dataResult({ artifact: { ...summary(value), source: value.source, libraries: value.libraries } });
			},
		}),
		defineTool({
			...common,
			name: "artifact_list",
			label: "List artifacts",
			description:
				"List current artifact summaries in this Pilot session, without source or compiled HTML. Use artifact_get for editable source or historical revisions.",
			annotations: { ...common.annotations, readOnlyHint: true },
			parameters: Type.Object({}),
			outputSchema: Type.Object({ artifacts: Type.Array(Type.Object(summaryProperties)) }),
			async execute(_callId, _params, signal) {
				signal?.throwIfAborted();
				return dataResult({ artifacts: (await store.list()).map(summary) });
			},
		}),
		defineTool({
			...common,
			name: "artifact_preview",
			label: "Preview artifact",
			description: `Render draft source to a PNG screenshot plus console diagnostics and contentHeight, without saving a revision or publishing. Optional width/height set the viewport. Requires Playwright Chromium; if missing, install with npm run artifacts:browser (npx playwright install chromium). In codemode: const r = await tools.artifact_preview(write); image({type:"image",...r.screenshot}); text({consoleMessages:r.consoleMessages,contentHeight:r.contentHeight}); Do not print screenshot base64 as text. ${authoring}`,
			annotations: { ...common.annotations, readOnlyHint: true },
			parameters: Type.Object({
				...writeProperties,
				width: Type.Optional(
					Type.Integer({ minimum: 240, maximum: 1600, description: "Viewport width in CSS pixels, default 800." }),
				),
				height: Type.Optional(
					Type.Integer({
						minimum: 200,
						maximum: 1600,
						description: "Viewport height in CSS pixels, default 600.",
					}),
				),
			}),
			outputSchema: Type.Object({
				screenshot: Type.Object({
					mimeType: Type.Literal("image/png"),
					data: Type.String(),
					width: Type.Number(),
					height: Type.Number(),
				}),
				...diagnosticsProperties,
			}),
			async execute(_callId, { width, height, ...write }, signal) {
				signal?.throwIfAborted();
				checkSource(write);
				const result = await (options.preview ?? previewArtifact)(write, { width, height, signal });
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
			},
		}),
	];
}
