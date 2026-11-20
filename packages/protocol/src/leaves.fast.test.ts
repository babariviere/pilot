import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

// Day's NSH sources import protocol leaves by relative path and cannot resolve the SDK packages.
const source = new URL("./", import.meta.url);
const day = new URL("../../../apps/day/", import.meta.url);
const sdkLeaf = new URL("chats/agent-events.ts", source).href;
const specifiers = (text: string) =>
	[...text.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]!);
const isRelative = (specifier: string) => specifier.startsWith("./") || specifier.startsWith("../");
const generated = new Set(["node_modules", "output", "target"]);

function* sourceFiles(directory: URL): Generator<URL> {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		if (entry.isDirectory() && !generated.has(entry.name))
			yield* sourceFiles(new URL(encodeURIComponent(entry.name) + "/", directory));
		if (entry.isFile() && /\.tsx?$/.test(entry.name)) yield new URL(encodeURIComponent(entry.name), directory);
	}
}

const leaves = new Map(
	[...sourceFiles(source)]
		.filter(({ pathname }) => pathname.endsWith(".ts") && !/(?:\/index|\.test)\.ts$/.test(pathname))
		.map((url) => [url.href, url]),
);

test("protocol leaves import only other leaves; only agent-events names SDK types", () => {
	assert.ok(leaves.has(sdkLeaf), "audit includes the SDK type leaf");
	for (const [href, url] of leaves) {
		const leaf = href.slice(source.href.length);
		const text = readFileSync(url, "utf8");
		for (const specifier of specifiers(text)) {
			if (isRelative(specifier)) {
				assert.ok(leaves.has(new URL(specifier, url).href), `${leaf} imports non-leaf ${specifier}`);
				continue;
			}
			assert.ok(href === sdkLeaf && specifier.startsWith("@earendil-works/"), `${leaf} imports ${specifier}`);
		}
		if (href === sdkLeaf) {
			assert.doesNotMatch(text, /^import (?!type )/m, "agent-events imports types only");
			assert.doesNotMatch(text, /^export (?!type )/m, "agent-events exports types only");
		}
	}
});

test("protocol leaves that Day imports reach neither index.ts nor SDK types", () => {
	const reached = new Set<string>();
	const visit = (url: URL, importer: URL) => {
		const { href } = url;
		if (reached.has(href)) return;
		assert.ok(leaves.has(href) && href !== sdkLeaf, `${importer.pathname} reaches non-Day leaf ${url.pathname}`);
		reached.add(href);
		for (const specifier of specifiers(readFileSync(url, "utf8")))
			if (isRelative(specifier)) visit(new URL(specifier, url), url);
	};
	for (const file of sourceFiles(day)) {
		for (const specifier of specifiers(readFileSync(file, "utf8"))) {
			if (!isRelative(specifier)) continue;
			const url = new URL(specifier, file);
			if (!url.href.startsWith(source.href) && !specifier.includes("/packages/protocol/src/")) continue;
			if (!url.pathname.endsWith(".ts")) url.pathname += ".ts";
			visit(url, file);
		}
	}
	assert.ok(reached.size > 0, "Day imports protocol leaves");
});
