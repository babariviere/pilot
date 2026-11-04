/** Exact retained input adapter and conservative projection over the existing TS/JS graph. */
import { createHash } from "node:crypto";
import { resolveCallGraph } from "./call-graph.ts";
import { type CallModule, callSyntax, GraphLimit } from "./call-path-syntax.ts";
import type { SourceHit } from "./exploration-contract.ts";
import { node, parseSource, type SyntaxNode, supportedSyntax } from "./exploration-parser.ts";
import { positions } from "./exploration-scan.ts";
import type {
	RetainedCallable,
	RetainedCallableDelta,
	RetainedCallInput,
	RetainedCallQuery,
	RetainedCallRef,
	RetainedCallResult,
	RetainedCallSite,
	RetainedSide,
	RetainedSpan,
} from "./retained-call-contract.ts";

const ENGINE = "retained-calls-v1/babel-8.1.0/shared-lexical-graph-v1";
const EXCLUDED = new Set([".git", ".jj", "node_modules", "target", "dist", ".next", ".cache"]);
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const key = (path: string, name: string, kind: string) => JSON.stringify([path, name, kind]);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface SideProjection {
	entities: Map<string, RetainedCallable[]>;
	edges: Map<string, RetainedCallSite[]>;
	parsed: Set<string>;
	inventory: Set<string>;
	bindings: Map<string, Set<string>>;
}

/** Original UTF-8 bytes are qualified before parsing; BOM is deliberately retained in text. */
function sourceSpans(bytes: Uint8Array, ref: RetainedCallRef) {
	const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	if (text.includes("\0")) throw new Error("Binary retained source");
	const offsets = new Uint32Array(text.length + 1);
	let byte = 0;
	for (let i = 0; i < text.length; ) {
		const point = text.codePointAt(i)!;
		const width = point > 0xffff ? 2 : 1;
		offsets[i] = byte;
		if (width === 2) offsets[i + 1] = 0xffffffff; // No span may split a surrogate pair.
		byte += Buffer.byteLength(String.fromCodePoint(point));
		i += width;
		offsets[i] = byte;
	}
	if (byte !== bytes.length) throw new Error("Retained encoding mismatch");
	const { span } = positions(text);
	const exact = (start: number, end: number): RetainedSpan => {
		if (
			![start, end].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= text.length) ||
			start > end ||
			offsets[start] === 0xffffffff ||
			offsets[end] === 0xffffffff
		)
			throw new Error("Invalid retained source span");
		const utf8 = { start: offsets[start]!, end: offsets[end]! };
		return { ...ref, utf16: span(start, end), utf8, sha256OfSpan: hash(bytes.subarray(utf8.start, utf8.end)) };
	};
	const hit = (start: number, end: number): SourceHit => ({
		path: ref.path,
		contentHash: ref.sha256,
		citation: `${ref.path}:${span(start, end).start.line}:${span(start, end).start.column}`,
		span: span(start, end),
		snippet: { text: "", span: span(start, start), truncated: true },
		coverage: "parsed",
		score: 0,
	});
	return { text, exact, hit };
}

function callables(ast: SyntaxNode, module: CallModule, exact: (start: number, end: number) => RetainedSpan) {
	const result: RetainedCallable[] = [];
	const frames = new Map(module.frames.map((frame) => [frame.location.span.start.offset, frame]));
	for (let value of ast.body as SyntaxNode[]) {
		if (["ExportNamedDeclaration", "ExportDefaultDeclaration"].includes(value.type) && node(value.declaration))
			value = value.declaration;
		const candidates: Array<{ value: SyntaxNode; id: SyntaxNode; declaration: SyntaxNode; kind: string }> = [];
		if (["FunctionDeclaration", "TSDeclareFunction"].includes(value.type) && node(value.id))
			candidates.push({ value, id: value.id, declaration: value, kind: value.type });
		if (value.type === "VariableDeclaration" && value.kind === "const")
			for (const item of value.declarations as SyntaxNode[])
				if (
					node(item.id) &&
					item.id.type === "Identifier" &&
					node(item.init) &&
					["ArrowFunctionExpression", "FunctionExpression"].includes(item.init.type)
				)
					candidates.push({ value: item.init, id: item.id, declaration: item, kind: `const:${item.init.type}` });
		for (const candidate of candidates) {
			const { value, id, declaration, kind } = candidate;
			const name = String(id.name);
			const body = node(value.body) ? value.body : undefined;
			const frame = frames.get(id.start);
			const duplicate = module.scope.bindings.get(name)?.length !== 1;
			result.push({
				name,
				kind,
				declaration: exact(declaration.start, declaration.end),
				header: body
					? [exact(declaration.start, body.start), exact(body.end, declaration.end)]
					: [exact(declaration.start, declaration.end)],
				body: body ? exact(body.start, body.end) : null,
				...(frame ? { frameId: frame.id } : {}),
				...(!body || !frame || duplicate
					? { reason: duplicate ? "ambiguous-top-level-binding" : "no-supported-implementation" }
					: {}),
			});
		}
	}
	return result;
}

export async function scanRetainedCalls(
	input: RetainedCallInput,
	query: RetainedCallQuery,
	read: (ref: RetainedCallRef) => Promise<Uint8Array>,
	stage: (side: RetainedSide) => Promise<void>,
	signal?: AbortSignal,
): Promise<RetainedCallResult> {
	const path = query.path ?? "";
	if (
		path &&
		(path.length > 400 ||
			path.split("/").some((p) => !p || p === "." || p === ".." || EXCLUDED.has(p)) ||
			/[\\:\x00-\x1f]/.test(path))
	)
		throw new Error("Invalid retained scan path");
	if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 50))
		throw new Error("Retained limit must be 1..50");
	if (query.offset !== undefined && (!Number.isSafeInteger(query.offset) || query.offset < 0 || query.offset > 1000))
		throw new Error("Invalid retained offset");
	if (
		![input.storeId, input.snapshotId].every((value) => /^[a-f0-9]{64}$/.test(value)) ||
		input.status === "unavailable"
	)
		throw new Error("Retained pair unavailable");
	const coverage = () => ({
		parsed: 0,
		unsupported: 0,
		omitted: 0,
		unresolvedCalls: 0,
		ambiguousCalls: 0,
		unpairedFrames: 0,
		contextCalls: 0,
	});
	const result: RetainedCallResult = {
		version: 1,
		mode: "source-inferred-not-runtime",
		engine: ENGINE,
		scanPath: path,
		pair: { storeId: input.storeId, snapshotId: input.snapshotId, request: input.request },
		revision: "",
		coverage: { before: coverage(), after: coverage() },
		budget: { entries: 0, bytes: 0, records: 0, edges: 0 },
		partial: false,
		partialReasons: [],
		exhaustive: false,
		results: [],
		page: { offset: query.offset ?? 0, retained: 0, nextOffset: null },
	};
	const partial = (reason: string) => {
		result.partial = true;
		if (!result.partialReasons.includes(reason)) result.partialReasons.push(reason);
	};
	if (input.status !== "complete") partial("retained-inventory-partial: absence-not-proven");
	const observed = createHash("sha256").update(
		JSON.stringify([ENGINE, result.pair, path, input.status, input.before, input.after]),
	);
	const sides = {} as Record<RetainedSide, SideProjection>;
	// Serial sides: ASTs never survive a file iteration. Only bounded exact projections survive a side.
	for (const side of ["before", "after"] as const) {
		await stage(side);
		signal?.throwIfAborted();
		if (!Array.isArray(input[side]) || input[side].length > 4096) throw new Error("Invalid retained inventory");
		const inventory = new Set(input[side].map((entry) => entry.path));
		if (inventory.size !== input[side].length) throw new Error("Duplicate retained path");
		const projection: SideProjection = {
			entities: new Map(),
			edges: new Map(),
			parsed: new Set(),
			inventory,
			bindings: new Map(),
		};
		sides[side] = projection;
		const modules = new Map<string, CallModule>();
		const spans = new Map<SourceHit, RetainedSpan>();
		const c = result.coverage[side];
		for (const entry of [...input[side]].sort((a, b) => compare(a.path, b.path))) {
			signal?.throwIfAborted();
			if (result.budget.entries >= 10_000) {
				partial("entry-limit");
				break;
			}
			result.budget.entries++;
			if (path && entry.path !== path && !entry.path.startsWith(`${path}/`)) continue;
			if (entry.path.split("/").some((p) => EXCLUDED.has(p))) {
				c.omitted++;
				partial("excluded-path");
				continue;
			}
			if (!supportedSyntax(entry.path)) {
				c.unsupported++;
				partial("unsupported-language");
				continue;
			}
			if (entry.state !== "text" || !entry.mode.startsWith("100") || entry.bytes === null || entry.sha256 === null) {
				c.omitted++;
				partial("retained-source-unavailable");
				continue;
			}
			if (entry.bytes > 512 * 1024) {
				c.omitted++;
				partial("file-size-limit");
				continue;
			}
			if (result.budget.bytes + entry.bytes > 32 * 1024 * 1024) {
				c.omitted++;
				partial("scan-byte-limit");
				break;
			}
			const ref = { snapshotId: input.snapshotId, side, path: entry.path, sha256: entry.sha256 };
			const bytes = await read(ref);
			if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256)
				throw new Error("Retained byte hash/size mismatch");
			result.budget.bytes += bytes.length;
			let source: ReturnType<typeof sourceSpans>;
			let ast: SyntaxNode;
			try {
				source = sourceSpans(bytes, ref);
				ast = parseSource(source.text, entry.path);
			} catch {
				c.omitted++;
				partial("retained-encoding-or-parse-failed");
				continue;
			}
			let module: CallModule;
			try {
				module = callSyntax(entry.path, ast, source.hit, () => {
					if (result.budget.records >= 20_000) throw new GraphLimit();
					result.budget.records++;
				});
			} catch (error) {
				if (!(error instanceof GraphLimit)) throw error;
				c.omitted++;
				partial("call-graph-record-limit");
				break;
			}
			c.parsed++;
			projection.parsed.add(entry.path);
			modules.set(entry.path, module);
			projection.bindings.set(entry.path, new Set(module.scope.bindings.keys()));
			for (const call of module.calls)
				spans.set(call.site, source.exact(call.site.span.start.offset, call.site.span.end.offset));
			for (const frame of module.frames)
				spans.set(frame.location, source.exact(frame.location.span.start.offset, frame.location.span.end.offset));
			for (const entity of callables(ast, module, source.exact)) {
				if (entity.name.length > 1000) {
					partial("callable-name-limit");
					continue;
				}
				const k = key(entry.path, entity.name, entity.kind);
				projection.entities.set(k, [...(projection.entities.get(k) ?? []), entity]);
			}
		}
		const graph = resolveCallGraph(modules, signal);
		c.unresolvedCalls = graph.unresolvedCalls;
		c.ambiguousCalls = graph.ambiguousCalls;
		if (c.unresolvedCalls || c.ambiguousCalls) partial("unresolved-or-ambiguous-static-calls");
		const byFrame = new Map<string, { k: string; entity: RetainedCallable }>();
		for (const [k, entities] of projection.entities)
			for (const entity of entities)
				if (entities.length === 1 && !entity.reason && entity.frameId) byFrame.set(entity.frameId, { k, entity });
		for (const module of modules.values()) {
			c.unpairedFrames += module.frames.filter((frame) => !byFrame.has(frame.id)).length;
			if (module.frames.some((frame) => frame.kind !== "Program" && !byFrame.has(frame.id)))
				partial("unsupported-or-ambiguous-callable-correspondence");
			c.contextCalls += module.calls.filter((call) => !byFrame.has(call.from.id)).length;
		}
		if (c.contextCalls) partial("calls-outside-compared-callables");
		projectEdges: for (const [from, edges] of graph.outgoing) {
			const caller = byFrame.get(from);
			if (!caller) continue;
			const sites: RetainedCallSite[] = [];
			projection.edges.set(caller.k, sites);
			for (const edge of edges) {
				if (result.budget.edges >= 1000) {
					partial("comparison-edge-limit");
					break projectEdges;
				}
				result.budget.edges++;
				const target = edge.to ? byFrame.get(edge.to.id) : undefined;
				sites.push({
					site: spans.get(edge.site)!,
					resolution: edge.resolution,
					provenance: edge.provenance,
					cycle: graph.cyclic.has(edge),
					...(target
						? {
								targetKey: target.k,
								target: {
									path: target.entity.declaration.path,
									name: target.entity.name,
									kind: target.entity.kind,
									declaration: target.entity.declaration,
								},
							}
						: {}),
					...(!target && edge.to
						? {
								unpairedTarget: {
									name: edge.to.name,
									kind: edge.to.kind,
									nameTruncated: edge.to.nameTruncated,
									location: spans.get(edge.to.location)!,
								},
							}
						: {}),
				});
			}
		}
		observed.update(JSON.stringify([side, c, [...projection.entities], [...projection.edges]]));
	}
	const keys = [...new Set([...sides.before.entities.keys(), ...sides.after.entities.keys()])].sort(compare);
	const matched = new Set(
		keys.filter((k) =>
			[sides.before, sides.after].every((s) => s.entities.get(k)?.length === 1 && !s.entities.get(k)![0]!.reason),
		),
	);
	const signatures = (edges: RetainedCallSite[]) => {
		const counts = new Map<string, number>();
		for (const edge of edges) if (edge.targetKey) counts.set(edge.targetKey, (counts.get(edge.targetKey) ?? 0) + 1);
		return JSON.stringify([...counts].sort(([a], [b]) => compare(a, b)));
	};
	const known = (edges: RetainedCallSite[]) => edges.every((edge) => edge.targetKey && matched.has(edge.targetKey));
	const deltas: RetainedCallableDelta[] = [];
	for (const k of keys) {
		if (deltas.length >= 1000) {
			partial("delta-record-limit");
			break;
		}
		const before = sides.before.entities.get(k) ?? [],
			after = sides.after.entities.get(k) ?? [];
		const entity = before[0] ?? after[0]!;
		const edges = { before: sides.before.edges.get(k) ?? [], after: sides.after.edges.get(k) ?? [] };
		let status: RetainedCallableDelta["status"] = "unknown",
			reason: string | undefined;
		if (matched.has(k)) status = "matched";
		else if ([...before, ...after].some((e) => e.reason) || before.length > 1 || after.length > 1)
			reason = "ambiguous-or-unsupported-correspondence";
		else {
			const opposite = before.length ? sides.after : sides.before;
			const conflictingKind = [...opposite.entities.values()].some((es) =>
				es.some((e) => e.declaration.path === entity.declaration.path && e.name === entity.name),
			);
			if (conflictingKind || opposite.bindings.get(entity.declaration.path)?.has(entity.name))
				reason = "declaration-kind-changed-or-unsupported-binding-no-correspondence";
			else if (
				opposite.parsed.has(entity.declaration.path) ||
				(input.status === "complete" && !opposite.inventory.has(entity.declaration.path))
			) {
				status = before.length ? "removed" : "added";
				reason = "same-path-name-kind-only: no-rename-or-move-inference";
			} else reason = "opposite-source-or-inventory-unavailable";
		}
		// A missing/failed module can hide another import candidate. Successful resolution in the
		// retained prefix alone cannot certify a relationship multiset for the requested scope.
		const completeEdges =
			input.status === "complete" &&
			result.coverage.before.omitted === 0 &&
			result.coverage.after.omitted === 0 &&
			!result.partialReasons.some((reason) =>
				["comparison-edge-limit", "scan-byte-limit", "entry-limit"].includes(reason),
			);
		const relationshipKnown = status === "matched" && completeEdges && known(edges.before) && known(edges.after);
		if (status !== "matched" || !relationshipKnown) partial("unpaired-entities-or-relationships");
		const headers = (e: RetainedCallable) => JSON.stringify(e.header.map((s) => s.sha256OfSpan));
		deltas.push({
			key: k,
			status,
			...(reason ? { reason } : {}),
			before,
			after,
			bodyChanged:
				status === "matched" && before[0]!.body && after[0]!.body
					? before[0]!.body!.sha256OfSpan !== after[0]!.body!.sha256OfSpan
					: null,
			headerChanged: status === "matched" ? headers(before[0]!) !== headers(after[0]!) : null,
			outgoingRelationshipChanged: relationshipKnown ? signatures(edges.before) !== signatures(edges.after) : null,
			lostResolution:
				status === "matched" &&
				edges.before.length > 0 &&
				edges.before.every((e) => e.resolution === "resolved" || e.resolution === "inferred") &&
				edges.after.some((e) => e.resolution === "unresolved" || e.resolution === "ambiguous"),
			edges,
		});
	}
	result.revision = observed.update(JSON.stringify([result.budget, result.partialReasons])).digest("hex");
	if (query.expectedRevision !== undefined && query.expectedRevision !== result.revision)
		throw new Error("Retained comparison revision changed");
	result.page.retained = deltas.length;
	for (let i = result.page.offset; i < deltas.length && result.results.length < (query.limit ?? 50); i++) {
		let delta = deltas[i]!;
		if (Buffer.byteLength(JSON.stringify(delta)) > 32 * 1024) {
			delta = { ...delta, edges: { before: [], after: [] }, edgesOmitted: true, outgoingRelationshipChanged: null };
			partial("output-record-limit: edges-omitted");
		}
		if (Buffer.byteLength(JSON.stringify({ ...result, results: [...result.results, delta] })) > 48 * 1024) {
			if (!result.results.length) throw new Error("Retained comparison metadata/record exceeds page budget");
			break;
		}
		result.results.push(delta);
	}
	const next = result.page.offset + result.results.length;
	result.page.nextOffset = next < deltas.length ? next : null;
	signal?.throwIfAborted();
	return result;
}
