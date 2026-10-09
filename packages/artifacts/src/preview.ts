/** Optional agent-side verification, isolated from the daemon and the user's browser profile. */
import { existsSync } from "node:fs";
import { type Browser, chromium } from "playwright";
import type { ArtifactWrite } from "@pilot/protocol";
import { ARTIFACT_RUNTIME_GUARD, getLibrary, isArtifactLibrary, prepareArtifact, validateArtifact } from "./render.ts";
import { isSwiftUIPreviewAvailable, previewSwiftUI } from "./swiftui.ts";

export interface ArtifactPreview {
	screenshot: { mimeType: "image/png"; data: string; width: number; height: number };
	consoleMessages: Array<{ level: string; text: string }>;
	contentHeight: number;
}

/** Probe the installed browser without launching it or triggering a download. */
export function isBrowserPreviewAvailable(): boolean {
	return existsSync(chromium.executablePath());
}

/** Probe installed renderers without launching them or triggering a download. */
export function isArtifactPreviewAvailable(): boolean {
	return isBrowserPreviewAvailable() || isSwiftUIPreviewAvailable();
}

// One headless browser is shared by previews and kept warm briefly. Every preview still gets a fresh,
// isolated context (no shared cookies, storage or cache), so reuse saves the launch, not the isolation.
const BROWSER_IDLE_MS = 60_000;
const CLOSE_TIMEOUT_MS = 5_000;
let sharedBrowser: Promise<Browser> | undefined;
let activePreviews = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function launchBrowser(): Promise<Browser> {
	if (!sharedBrowser) {
		const launching = chromium
			.launch({
				executablePath: chromium.executablePath(),
				headless: true,
				chromiumSandbox: true,
				timeout: 15_000,
				args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--dns-prefetch-disable"],
			})
			.then((browser) => {
				// A crashed browser is replaced on the next preview instead of failing every later call.
				browser.on("disconnected", () => {
					if (sharedBrowser === launching) sharedBrowser = undefined;
				});
				return browser;
			});
		sharedBrowser = launching;
		launching.catch(() => {
			if (sharedBrowser === launching) sharedBrowser = undefined;
		});
	}
	return sharedBrowser;
}

/** Close the warm preview browser. Bounded, so shutdown never waits on a wedged browser. */
export async function closePreviewBrowser(): Promise<void> {
	if (idleTimer) clearTimeout(idleTimer);
	idleTimer = undefined;
	const pending = sharedBrowser;
	sharedBrowser = undefined;
	const browser = await pending?.catch(() => undefined);
	if (browser)
		await withTimeout(
			browser.close().catch(() => undefined),
			CLOSE_TIMEOUT_MS,
		);
}

function scheduleIdleClose(): void {
	if (idleTimer) clearTimeout(idleTimer);
	idleTimer = setTimeout(() => {
		idleTimer = undefined;
		if (activePreviews === 0) void closePreviewBrowser();
	}, BROWSER_IDLE_MS);
	idleTimer.unref();
}

export async function previewArtifact(
	write: ArtifactWrite,
	options: { width?: number; height?: number; signal?: AbortSignal; timeoutMs?: number } = {},
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
	if (write.kind === "swiftui") return previewSwiftUI(validateArtifact(write).source, options);
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
	const timeoutMs = options.timeoutMs ?? 30_000;
	activePreviews++;
	if (idleTimer) clearTimeout(idleTimer);
	let browser: Browser;
	try {
		browser = await launchBrowser();
	} catch (error) {
		activePreviews--;
		scheduleIdleClose();
		throw new Error(
			`Artifact preview browser could not start. Preview is optional; publish without it. ${error instanceof Error ? error.message : error}`,
		);
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	let timedOut = false;
	let settled = false;
	let context: Awaited<ReturnType<Browser["newContext"]>> | undefined;
	try {
		const stopped = new Promise<never>((_resolve, reject) => {
			abort = () => reject(new Error("Artifact preview aborted"));
			options.signal?.addEventListener("abort", abort, { once: true });
			if (options.signal?.aborted) abort();
			timer = setTimeout(() => {
				timedOut = true;
				reject(new Error(`Artifact preview timed out after ${Math.round(timeoutMs / 1000)} seconds`));
			}, timeoutMs);
		});
		const render = async (): Promise<ArtifactPreview> => {
			context = await browser.newContext({
				viewport: { width, height },
				serviceWorkers: "block",
				acceptDownloads: false,
			});
			// An abort can win the race before the context exists; never leave it running in the warm browser.
			if (settled) {
				await context.close().catch(() => undefined);
				throw new Error("Artifact preview aborted");
			}
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
			await page.goto(`${origin}/document`, { waitUntil: "load", timeout: Math.min(20_000, timeoutMs) });
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
		settled = true;
		if (timer) clearTimeout(timer);
		if (abort) options.signal?.removeEventListener("abort", abort);
		// The render may still be running after a timeout or abort. Closing the context stops it; if
		// even that hangs, the browser is wedged and is replaced rather than reused.
		const pendingContext = context as Awaited<ReturnType<Browser["newContext"]>> | undefined;
		const closed = pendingContext
			? await withTimeout(
					pendingContext.close().then(
						() => true,
						() => false,
					),
					CLOSE_TIMEOUT_MS,
				)
			: true;
		activePreviews--;
		if (!closed || timedOut) {
			if (activePreviews === 0) await closePreviewBrowser();
		} else scheduleIdleClose();
	}
}
