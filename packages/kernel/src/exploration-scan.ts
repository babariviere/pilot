/** Fresh, bounded query scan. Runs only in a disposable worker, never on the daemon/model loop. */
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { ExplorationPage, ExplorationQuery, SourceHit } from "./exploration-contract.ts";
import { paginate } from "./exploration-page.ts";
import {
	type Declaration,
	parseDeclarations,
	parseSource,
	type SyntaxNode,
	supportedSyntax,
} from "./exploration-parser.ts";
import type { AskContext } from "./policy.ts";
import { ReadLimitError, SourceReader, sourcePath } from "./source-reader.ts";

const MAX_ENTRIES = 10_000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_RESULTS = 1000;
const EXCLUDED = [".git", ".jj", "node_modules", "target", "dist", ".next", ".cache"];
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const order = (a: SourceHit, b: SourceHit) =>
	b.score - a.score || compare(a.path, b.path) || a.span.start.offset - b.span.start.offset;
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export function positions(text: string) {
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
	const position = (offset: number) => {
		let low = 0;
		let high = starts.length;
		while (low + 1 < high) {
			const middle = (low + high) >>> 1;
			if (starts[middle]! <= offset) low = middle;
			else high = middle;
		}
		return { offset, line: low + 1, column: offset - starts[low]! + 1 };
	};
	const span = (start: number, end: number) => ({ start: position(start), end: position(end) });
	return { starts, span };
}

export interface SourceObserver {
	identity: unknown;
	file(path: string, ast: SyntaxNode, hit: (start: number, end: number) => SourceHit): boolean;
}

export async function scanSource(
	source: AskContext,
	input: ExplorationQuery,
	signal?: AbortSignal,
	observer?: SourceObserver,
): Promise<ExplorationPage> {
	const reader = new SourceReader(source);
	const path = sourcePath(reader.root, input.path ?? ".");
	if (path.split("/").some((part) => EXCLUDED.includes(part))) throw new Error("Exploration path is excluded");
	const query = { tool: input.tool, query: input.query ?? "", path, exact: input.exact ?? false };
	const root = await realpath(reader.root);
	const identity = {
		root,
		kind: source.commit ? "pinned-commit" : "workspace",
		...(source.commit ? { commit: source.commit } : {}),
	};
	const fingerprint = createHash("sha256");
	const engine = "source-scan-v2/babel-7.28.5";
	const store = source.gitDir ? await realpath(source.gitDir) : null;
	const sourceId = sha(JSON.stringify([identity, store]));
	const observed = createHash("sha256").update(JSON.stringify([engine, sourceId, path, observer?.identity ?? null]));
	const observe = (value: unknown) => {
		const encoded = JSON.stringify(value);
		fingerprint.update(encoded);
		observed.update(encoded);
	};
	// Include the canonical *workspace*, query, engine version, and host-selected snapshot store.
	fingerprint.update(JSON.stringify([2, identity, store, query]));
	if (observer) fingerprint.update(JSON.stringify(observer.identity));
	const page: ExplorationPage = {
		version: 1,
		revision: {
			id: "",
			sourceId,
			kind: source.commit ? "pinned-content" : "observed-content",
			engine,
			consistency: "per-file-read-not-atomic",
		},
		query,
		source: identity,
		freshness: {
			startedAt: new Date().toISOString(),
			finishedAt: "",
			fingerprint: "",
			consistency: "per-file-read-not-atomic",
			includesUncommitted: !source.commit,
		},
		coverage: {
			parsed: 0,
			lexical: 0,
			unsupported: 0,
			semantics: "named-declarations-not-reference-resolution",
			parser: "@babel/parser 7.28.5: TS/TSX/JS/JSX, no project config",
		},
		scan: { files: 0, bytes: 0, entries: 0 },
		exclusions: {},
		exclusionPolicy: [
			...EXCLUDED,
			"symlinks",
			"submodules",
			"binary",
			"non-UTF8",
			"files >512 KiB",
			"explicit rules only, not gitignore",
		],
		failures: [],
		failureCount: 0,
		partial: false,
		partialReasons: [],
		results: [],
		page: { offset: 0, returned: 0, matchesObserved: 0, retained: 0 },
	};
	const partial = (reason: string) => {
		page.partial = true;
		if (!page.partialReasons.includes(reason)) page.partialReasons.push(reason);
	};
	const exclude = (reason: string) => {
		page.exclusions[reason] = (page.exclusions[reason] ?? 0) + 1;
	};
	const fail = (path: string, reason: string) => {
		page.failureCount++;
		if (page.failures.length < 8)
			page.failures.push({ path: path.length > 512 ? `${path.slice(0, 512)} [path truncated]` : path, reason });
		observe(["failure", path, reason]);
		partial("read-or-parse-failures");
	};
	const hits: SourceHit[] = [];
	const add = (hit: SourceHit) => {
		page.page.matchesObserved++;
		let low = 0;
		let high = hits.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (order(hits[middle]!, hit) <= 0) low = middle + 1;
			else high = middle;
		}
		if (low < MAX_RESULTS) {
			hits.splice(low, 0, hit);
			if (hits.length > MAX_RESULTS) hits.pop();
		}
	};
	async function* files(): AsyncGenerator<string> {
		const kind = await reader.kind(path, signal);
		if (kind === "file") {
			yield path;
			return;
		}
		if (kind !== "directory") throw new Error("Exploration denies symlinks and submodules");
		const pending = [path];
		while (pending.length) {
			const dir = pending.pop()!;
			let entries: Awaited<ReturnType<SourceReader["list"]>>;
			try {
				entries = await reader.list(dir, signal);
			} catch (error) {
				signal?.throwIfAborted();
				if (error instanceof Error && error.message.includes("10000 entry limit")) {
					partial("directory-entry-limit: narrow path");
					return;
				}
				if (dir === path) throw error;
				fail(dir, "directory-unreadable-or-limit");
				continue;
			}
			entries.sort((a, b) => compare(a.name, b.name));
			for (const entry of entries) {
				if (++page.scan.entries > MAX_ENTRIES) {
					partial("entry-limit: narrow path");
					return;
				}
				const name = dir ? `${dir}/${entry.name}` : entry.name;
				observe([name, entry.kind]);
				if (EXCLUDED.includes(entry.name)) exclude(entry.name);
				else if (entry.kind === "directory") pending.push(name);
				else if (entry.kind === "file") yield name;
				else exclude(entry.kind);
			}
		}
	}
	for await (const name of files()) {
		signal?.throwIfAborted();
		page.scan.files++;
		if (name.length > 4096) {
			fail(name.slice(0, 256), "path-too-long");
			continue;
		}
		if (input.tool === "code_symbols" && !supportedSyntax(name)) {
			page.coverage.unsupported++;
			exclude("unsupported-symbol-language");
			partial("unsupported-symbol-language");
			continue;
		}
		let bytes: Buffer;
		try {
			bytes = await reader.read(name, signal, MAX_FILE_BYTES);
		} catch (error) {
			signal?.throwIfAborted();
			if (error instanceof ReadLimitError) {
				exclude("oversized");
				partial("file-size-limit");
				observe(["oversized", name]);
			} else fail(name, "unreadable-or-changed-during-read");
			continue;
		}
		if (page.scan.bytes + bytes.length > MAX_BYTES) {
			partial("scan-byte-limit: narrow path");
			break;
		}
		page.scan.bytes += bytes.length;
		const hash = sha(bytes);
		observe([name, hash]);
		if (bytes.includes(0)) {
			exclude("binary");
			continue;
		}
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		} catch {
			exclude("non-UTF8");
			continue;
		}
		let declarations: Declaration[] = [];
		let ast: SyntaxNode | undefined;
		let coverage: "parsed" | "lexical" = "lexical";
		if (supportedSyntax(name)) {
			try {
				ast = parseSource(text, name);
				if (!observer) declarations = parseDeclarations(text, name, ast);
				coverage = "parsed";
				page.coverage.parsed++;
			} catch {
				fail(name, "syntax-parse-failed: search falls back to lexical; symbols omitted");
			}
		}
		if (coverage === "lexical") page.coverage.lexical++;
		const { starts, span } = positions(text);
		const hit = (start: number, end: number, score: number, declaration?: Declaration): SourceHit => {
			const location = span(start, end);
			const lineStart = starts[location.start.line - 1]!;
			const lineEnd = (starts[location.start.line] ?? text.length + 1) - 1;
			const snippetStart = Math.max(lineStart, start - 100);
			const snippetEnd = Math.min(text.length, lineEnd, snippetStart + 400);
			return {
				path: name,
				citation: `${name}:${location.start.line}:${location.start.column}`,
				contentHash: hash,
				span: location,
				snippet: {
					text: text.slice(snippetStart, snippetEnd),
					span: span(snippetStart, snippetEnd),
					truncated: snippetStart > lineStart || snippetEnd < lineEnd,
				},
				coverage,
				score,
				...(declaration
					? {
							name: declaration.name.slice(0, 200),
							nameTruncated: declaration.name.length > 200,
							kind: declaration.kind,
							container: declaration.container?.slice(0, 200),
							containerTruncated: (declaration.container?.length ?? 0) > 200,
						}
					: {}),
			};
		};
		if (observer) {
			if (ast && !observer.file(name, ast, (start, end) => hit(start, end, 0))) {
				partial("call-graph-record-limit: narrow path");
				break;
			}
			continue;
		}
		if (input.tool === "code_symbols") {
			for (const declaration of declarations) {
				if (query.exact ? declaration.name !== query.query : !declaration.name.includes(query.query)) continue;
				add(
					hit(
						declaration.start,
						declaration.end,
						declaration.name === query.query ? 100 : declaration.name.startsWith(query.query) ? 80 : 60,
						declaration,
					),
				);
			}
		} else {
			let declarationIndex = 0;
			for (let line = 0; line < starts.length; line++) {
				const start = starts[line]!;
				const end = starts[line + 1] ?? text.length;
				const localMatch = text.slice(start, end).indexOf(query.query);
				if (localMatch < 0) continue;
				const match = start + localMatch;
				while (declarationIndex < declarations.length && declarations[declarationIndex]!.start <= match)
					declarationIndex++;
				let declaration: Declaration | undefined;
				// Ranking context only. Bound backward work for deeply nested/generated source.
				for (let i = declarationIndex - 1; i >= Math.max(0, declarationIndex - 64); i--)
					if (declarations[i]!.extentStart <= match && declarations[i]!.extentEnd >= match + query.query.length) {
						declaration = declarations[i];
						break;
					}
				const exactName = declaration?.start === match && declaration?.name === query.query;
				const score = exactName ? 100 : declaration?.start === match ? 80 : declaration ? 30 : 10;
				add(hit(match, match + query.query.length, score, declaration));
			}
		}
	}
	// Observed contents and scan omissions, not query matches or traversal/page truncation.
	observed.update(JSON.stringify([page.scan, page.coverage, page.exclusions, page.failureCount, page.partialReasons]));
	page.revision.id = observed.digest("hex");
	if (page.page.matchesObserved > MAX_RESULTS) partial("top-1000-results-only: narrow query");
	page.freshness.fingerprint = fingerprint.digest("hex");
	page.freshness.finishedAt = new Date().toISOString();
	paginate(page, hits, input);
	return page;
}
