/** A deliberately small offline browser runtime. Generated code never installs packages. */
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import type { ArtifactLibrary, ArtifactWrite } from "@pilot/protocol";
import { MAX_IMAGE_SOURCE_BYTES, validateImageSource } from "./image.ts";
import { previewSwiftUI } from "./swiftui.ts";

const require = createRequire(import.meta.url);
const resolveDir = dirname(fileURLToPath(import.meta.url));

export const artifactLibraries: Record<ArtifactLibrary, { version: string; description: string; global: string }> = {
	react: { version: "19.3.0", description: "Interactive component interfaces", global: "React" },
	"react-dom": { version: "19.3.0", description: "React DOM rendering, including createRoot", global: "ReactDOM" },
	mermaid: {
		version: "12.1.0",
		description: "Flowcharts, sequence diagrams and dependency diagrams",
		global: "mermaid",
	},
	echarts: { version: "6.1.0", description: "Charts, dashboards and graph visualizations", global: "echarts" },
	motion: { version: "14.0.0", description: "Animation, including motion/react for JSX artifacts", global: "motion" },
	d3: { version: "7.9.0", description: "Optional custom data visualization library", global: "d3" },
	three: { version: "0.186.1", description: "Optional WebGL and 3D scenes", global: "THREE" },
};

export function isArtifactLibrary(value: unknown): value is ArtifactLibrary {
	return typeof value === "string" && Object.hasOwn(artifactLibraries, value);
}

export const MAX_SOURCE_BYTES = 512 * 1024;

export function validateArtifact(write: ArtifactWrite): ArtifactWrite & { libraries: ArtifactLibrary[] } {
	if (!write || typeof write !== "object") throw new Error("Expected an artifact document");
	if (typeof write.title !== "string" || !write.title.trim() || write.title.length > 160)
		throw new Error("Artifact title must contain 1-160 characters");
	if (write.kind !== "html" && write.kind !== "react" && write.kind !== "image" && write.kind !== "swiftui")
		throw new Error("Artifact kind must be html, react, image or swiftui");
	const maxBytes = write.kind === "image" ? MAX_IMAGE_SOURCE_BYTES : MAX_SOURCE_BYTES;
	if (typeof write.source !== "string" || !write.source.trim() || Buffer.byteLength(write.source) > maxBytes)
		throw new Error(
			write.kind === "image"
				? "Artifact image exceeds 16 MiB or is empty"
				: "Artifact source must contain 1-512 KiB of HTML, JSX/TSX or SwiftUI",
		);
	if (write.kind === "image") validateImageSource(write.source);
	if (write.libraries !== undefined && (!Array.isArray(write.libraries) || !write.libraries.every(isArtifactLibrary)))
		throw new Error("Unknown artifact library. Use the bundled library names only");
	const libraries = [...new Set(write.libraries ?? [])];
	if (write.kind === "image" && libraries.length) throw new Error("Image artifacts do not use libraries");
	if (write.kind === "swiftui" && libraries.length) throw new Error("SwiftUI artifacts do not use libraries");
	if (libraries.includes("react-dom")) {
		const reactIndex = libraries.indexOf("react");
		if (reactIndex !== -1) libraries.splice(reactIndex, 1);
		libraries.unshift("react");
	}
	return { ...write, title: write.title.trim(), libraries };
}

const libraryBuilds = new Map<ArtifactLibrary, Promise<string>>();

/** Libraries are built only when requested. D3 and Three are opt-in, not injected by default. */
export function getLibrary(name: ArtifactLibrary): Promise<string> {
	if (!isArtifactLibrary(name)) return Promise.reject(new Error("Unknown artifact library"));
	let pending = libraryBuilds.get(name);
	if (!pending) {
		const source =
			name === "react-dom"
				? 'import * as dom from "react-dom"; import * as client from "react-dom/client"; globalThis.ReactDOM = {...dom, ...client};'
				: name === "mermaid"
					? 'import mermaid from "mermaid"; globalThis.mermaid = mermaid;'
					: `import * as library from ${JSON.stringify(name)}; globalThis.${artifactLibraries[name].global} = library;`;
		pending = build({
			stdin: { contents: source, resolveDir },
			bundle: true,
			write: false,
			platform: "browser",
			format: "iife",
			target: "safari17",
			minify: true,
			define: { "process.env.NODE_ENV": '"production"' },
			plugins:
				name === "react-dom"
					? [
							{
								name: "shared-react-global",
								setup(builder) {
									builder.onResolve({ filter: /^react$/ }, () => ({
										path: "react",
										namespace: "global-react",
									}));
									builder.onLoad({ filter: /.*/, namespace: "global-react" }, () => ({
										contents: "module.exports = globalThis.React;",
										loader: "js",
									}));
								},
							},
						]
					: [],
			logLevel: "silent",
		}).then((result) => result.outputFiles[0]!.text);
		libraryBuilds.set(name, pending);
		pending.catch(() => libraryBuilds.delete(name));
	}
	return pending;
}

// Imports in the agent's source are restricted; installed libraries may resolve their own dependencies.
const allowedImports = new Set([
	"react",
	"react/jsx-runtime",
	"react/jsx-dev-runtime",
	"react-dom",
	"react-dom/client",
	"mermaid",
	"echarts",
	"motion",
	"motion/react",
	"d3",
	"three",
]);

async function compileReact(source: string): Promise<string> {
	const plugin: Plugin = {
		name: "pilot-artifact-imports",
		setup(builder) {
			builder.onResolve({ filter: /^artifact-source$/ }, () => ({ path: "artifact-source", namespace: "artifact" }));
			builder.onLoad({ filter: /.*/, namespace: "artifact" }, () => ({
				contents: source,
				loader: "tsx",
				resolveDir,
			}));
			builder.onResolve({ filter: /.*/, namespace: "artifact" }, (args) => {
				if (!allowedImports.has(args.path))
					return {
						errors: [
							{
								text: `Import ${JSON.stringify(args.path)} is not available. Only bundled artifact libraries are allowed.`,
							},
						],
					};
				return { path: require.resolve(args.path) };
			});
		},
	};
	const result = await build({
		stdin: {
			contents:
				'import React from "react"; import {createRoot} from "react-dom/client"; import Artifact from "artifact-source"; createRoot(document.getElementById("artifact-root")).render(React.createElement(Artifact));',
			resolveDir,
			loader: "tsx",
		},
		plugins: [plugin],
		bundle: true,
		write: false,
		platform: "browser",
		format: "iife",
		target: "safari17",
		jsx: "automatic",
		supported: { "inline-script": false },
		minify: true,
		define: { "process.env.NODE_ENV": '"production"' },
		logLevel: "silent",
	});
	return result.outputFiles[0]!.text;
}

/** Never give an artifact an app origin, network access, or a native capability bridge. */
export const ARTIFACT_CSP =
	"default-src 'none'; script-src 'unsafe-inline' pilot-artifact:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; media-src data: blob:; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";

const styles = `:root {color-scheme:light;--pilot-background:#fff;--pilot-foreground:#262626;--pilot-muted:#fafafa;--pilot-muted-foreground:#6b6b6b;--pilot-border:rgba(0,0,0,0.08);--pilot-primary:#262626;--pilot-radius:10px;font-family:system-ui,sans-serif;font-size:14px;} body {margin:0;padding:16px;background:var(--pilot-background);color:var(--pilot-foreground);overflow-wrap:anywhere;} * {box-sizing:border-box;} button,input,select,textarea {font:inherit;} canvas,svg,img {max-width:100%;} @media(prefers-reduced-motion:reduce) {* {animation-duration:0.01ms!important;transition-duration:0.01ms!important;}}`;
// Compiled code must not pass through HTML's script parser: even valid JS strings can
// contain <!--, <script or </script. An inline bootstrap decodes UTF-8 and inserts a
// script node by textContent. This preserves tagged-template raw strings too, without eval.
function compiledScript(code: string): string {
	const encoded = Buffer.from(code).toString("base64");
	return `<script>{const code=Uint8Array.from(atob("${encoded}"),c=>c.charCodeAt(0));const script=document.createElement("script");script.textContent=new TextDecoder().decode(code);document.body.appendChild(script);}</script>`;
}

/** CSP and request interception do not cover WebRTC STUN/TURN sockets. Remove these capabilities
 * before any generated code. Hosts additionally install this at document start in every frame. */
export const ARTIFACT_RUNTIME_GUARD = `for (const name of ['RTCPeerConnection','webkitRTCPeerConnection','mozRTCPeerConnection','WebTransport']) { try { Object.defineProperty(globalThis,name,{value:undefined,writable:false,configurable:false}); } catch (_) {} }`;

export async function prepareArtifact(
	input: ArtifactWrite,
	options: { signal?: AbortSignal } = {},
): Promise<{ html: string; libraries: ArtifactLibrary[] }> {
	const write = validateArtifact(input);
	options.signal?.throwIfAborted();
	let imageSource = write.kind === "image" ? write.source : undefined;
	if (write.kind === "swiftui") {
		const preview = await previewSwiftUI(write.source, options);
		// Retain SwiftUI source/kind in the stored revision;
		// opening it later never executes Swift or requires the original toolchain.
		imageSource = `data:image/png;base64,${preview.screenshot.data}`;
	}
	// The policy is the first node, before any untrusted source. Nested full HTML documents are parsed
	// as body content, which is intentional: generated source cannot precede the policy in the head.
	const libraries = write.libraries
		.map((name) => `<script src="pilot-artifact://library/${name}"></script>`)
		.join("\n");
	const body =
		write.kind === "react"
			? `<div id="artifact-root"></div>${compiledScript(await compileReact(write.source))}`
			: imageSource !== undefined
				? `<style>body{padding:0;min-height:100vh;display:grid;place-items:center}img{display:block;width:auto;height:auto;max-width:${write.kind === "swiftui" ? "min(100vw,800px)" : "100vw"};max-height:${write.kind === "swiftui" ? "min(100vh,600px)" : "100vh"};object-fit:contain}</style><img alt="Artifact image" src="${imageSource}">`
				: write.source;
	const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}"><meta http-equiv="x-dns-prefetch-control" content="off"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><script>${ARTIFACT_RUNTIME_GUARD}</script><style>${styles}</style>${libraries}</head><body>${body}</body></html>`;
	if (Buffer.byteLength(html) > 25 * 1024 * 1024) throw new Error("Prepared artifact exceeds 25 MiB");
	return { html, libraries: write.libraries };
}
