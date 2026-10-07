/** Optional agent-side verification, isolated from the daemon and the user's browser profile. */
import { type Browser, chromium } from "playwright";
import type { ArtifactWrite } from "@pilot/protocol";
import { ARTIFACT_RUNTIME_GUARD, getLibrary, isArtifactLibrary, prepareArtifact } from "./render.ts";

export interface ArtifactPreview {
	screenshot: { mimeType: "image/png"; data: string; width: number; height: number };
	consoleMessages: Array<{ level: string; text: string }>;
	contentHeight: number;
}

export async function previewArtifact(
	write: ArtifactWrite,
	options: { width?: number; height?: number; signal?: AbortSignal } = {},
): Promise<ArtifactPreview> {
	const width = options.width ?? 800;
	const height = options.height ?? 600;
	if (
		!Number.isInteger(width) ||
		width < 240 ||
		width > 1600 ||
		!Number.isInteger(height) ||
		height < 200 ||
		height > 1600
	)
		throw new Error("Preview width must be 240-1600 and height 200-1600 CSS pixels");
	options.signal?.throwIfAborted();
	const prepared = await prepareArtifact(write);
	const libraries = new Map(
		await Promise.all(prepared.libraries.map(async (name) => [name, await getLibrary(name)] as const)),
	);
	options.signal?.throwIfAborted();
	// Replace only trusted runtime URLs, then serve them through an in-memory request interceptor.
	const origin = "https://artifact.invalid";
	const html = prepared.html
		.replaceAll("pilot-artifact://library/", `${origin}/library/`)
		.replace("pilot-artifact:;", `${origin};`);
	let browser: Browser;
	try {
		browser = await chromium.launch({
			headless: true,
			chromiumSandbox: true,
			timeout: 15_000,
			args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--dns-prefetch-disable"],
		});
	} catch (error) {
		throw new Error(
			`Artifact preview browser could not start. Install it with npm run artifacts:browser. ${error instanceof Error ? error.message : error}`,
		);
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	try {
		const stopped = new Promise<never>((_resolve, reject) => {
			abort = () => reject(new Error("Artifact preview aborted"));
			options.signal?.addEventListener("abort", abort, { once: true });
			if (options.signal?.aborted) abort();
			timer = setTimeout(() => reject(new Error("Artifact preview timed out after 30 seconds")), 30_000);
		});
		const render = async (): Promise<ArtifactPreview> => {
			const context = await browser.newContext({
				viewport: { width, height },
				serviceWorkers: "block",
				acceptDownloads: false,
			});
			await context.addInitScript(ARTIFACT_RUNTIME_GUARD);
			await context.route("**/*", async (route) => {
				const url = new URL(route.request().url());
				if (url.origin === origin && url.pathname === "/document")
					return route.fulfill({ contentType: "text/html", body: html });
				const name = url.pathname.startsWith("/library/") ? url.pathname.slice(9) : undefined;
				if (url.origin === origin && isArtifactLibrary(name) && libraries.has(name))
					return route.fulfill({ contentType: "text/javascript", body: libraries.get(name)! });
				return route.abort("blockedbyclient");
			});
			const page = await context.newPage();
			await page.routeWebSocket(/.*/, (socket) => socket.close());
			const consoleMessages: ArtifactPreview["consoleMessages"] = [];
			const record = (level: string, text: string) => {
				if (consoleMessages.length < 100) consoleMessages.push({ level, text: text.slice(0, 2000) });
			};
			page.on("console", (message) => record(message.type(), message.text()));
			page.on("pageerror", (error) => record("error", error.message));
			page.on("popup", (popup) => void popup.close());
			await page.goto(`${origin}/document`, { waitUntil: "load", timeout: 20_000 });
			await page.waitForTimeout(300);
			const contentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
			const png = await page.screenshot({ type: "png", timeout: 5000 });
			return {
				screenshot: { mimeType: "image/png", data: png.toString("base64"), width, height },
				consoleMessages,
				contentHeight,
			};
		};
		return await Promise.race([render(), stopped]);
	} finally {
		if (timer) clearTimeout(timer);
		if (abort) options.signal?.removeEventListener("abort", abort);
		await browser.close();
	}
}
