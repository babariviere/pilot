/** One bounded shared source scan per graph query, not per traversed frame. */
import { createHash } from "node:crypto";
import { posix, resolve } from "node:path";
import type { CallEdge, CallFrame, CallPathPage, CallPathQuery } from "./call-path-contract.ts";
import { type Binding, type CallModule, callSyntax, GraphLimit, lookup } from "./call-path-syntax.ts";
import { paginate } from "./exploration-page.ts";
import { scanSource } from "./exploration-scan.ts";
import type { AskContext } from "./policy.ts";
import { sourcePath } from "./source-reader.ts";

const MAX_RECORDS = 20_000;
const MAX_RESULTS = 1000;
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const LIMITATIONS = [
	"Static lexical relationships, not runtime execution, reachability, type checking or impact proof.",
	"Only direct identifier calls bind locally; member/optional/new/tagged/dynamic dispatch, aliases and callback invocation are unresolved. Callback bodies are separate frames, not invoked argument edges.",
	"Relative ESM imports: scanned explicit files or unique extension/index candidates only. No package/config aliases, namespace imports, re-exports, CommonJS or TS runtime extension substitution.",
	"Live scans are per-file windows, not an atomic tree. Cross-file edges are inferred, even for explicit imports. No callers found is not proof of no impact.",
	"Reassigned/duplicate bindings, eval/with/namespaces and sloppy block functions are conservative unknowns. Temporal execution order and external mutation are not modeled. Module frames are lexical enclosing contexts, including class initializers.",
];

type Resolution = Pick<CallEdge, "to" | "resolution" | "provenance">;

/** Import paths are looked up only in already trusted/scanned modules. Never perform extra reads. */
function resolveBinding(binding: Binding, module: CallModule, modules: Map<string, CallModule>): Resolution {
	if (module.unsafe || binding.written)
		return { resolution: "unresolved", provenance: "dynamic-scope-or-reassigned-binding" };
	if (binding.frame) return { to: binding.frame, resolution: "resolved", provenance: "same-file-lexical-binding" };
	if (!binding.imported) return { resolution: "unresolved", provenance: "non-callable-or-unsupported-binding" };
	const { source, name } = binding.imported;
	if (!source.startsWith("./") && !source.startsWith("../"))
		return { resolution: "unresolved", provenance: "package-or-alias-import-not-supported" };
	const base = posix.normalize(posix.join(posix.dirname(module.path), source));
	if (base.startsWith("../") || base.startsWith("/") || /[\\\0?#]/.test(source))
		return { resolution: "unresolved", provenance: "import-outside-supported-source" };
	const candidates = modules.has(base)
		? [base]
		: posix.extname(base)
			? []
			: [...EXTENSIONS.map((ext) => base + ext), ...EXTENSIONS.map((ext) => `${base}/index${ext}`)].filter((path) =>
					modules.has(path),
				);
	if (candidates.length > 1)
		return { resolution: "ambiguous", provenance: "multiple-relative-import-file-candidates-no-edge" };
	const targetModule = candidates[0] ? modules.get(candidates[0]) : undefined;
	if (!targetModule || targetModule.unsafe)
		return { resolution: "unresolved", provenance: "import-not-in-parsed-scan-or-dynamic-scope" };
	const names = targetModule.exports.get(name);
	if (!names?.length) return { resolution: "unresolved", provenance: "export-missing-or-re-export-unsupported" };
	const targets = names.flatMap((name) => targetModule.scope.bindings.get(name) ?? []);
	if (targets.length > 1 || names.length > 1)
		return { resolution: "ambiguous", provenance: "multiple-export-bindings-no-edge" };
	const target = targets[0];
	if (!target?.frame || target.written)
		return { resolution: "unresolved", provenance: "export-not-direct-callable-or-reassigned" };
	return {
		to: target.frame,
		resolution: "inferred",
		provenance:
			candidates[0] === base
				? "relative-esm-explicit-export-per-file-window"
				: "relative-esm-unique-file-candidate-not-compiler-resolution",
	};
}

export async function scanCallPaths(
	source: AskContext,
	input: CallPathQuery,
	signal?: AbortSignal,
): Promise<CallPathPage> {
	signal?.throwIfAborted();
	const query = {
		symbol: { ...input.symbol, path: sourcePath(resolve(source.source), input.symbol.path) },
		direction: input.direction,
		depth: input.depth ?? 1,
		path: sourcePath(resolve(source.source), input.path ?? "."),
	};
	const modules = new Map<string, CallModule>();
	let records = 0;
	const scanned = await scanSource(source, { tool: "code_symbols", path: query.path }, signal, {
		identity: ["call-paths-v1", query],
		file(path, ast, hit) {
			try {
				modules.set(
					path,
					callSyntax(path, ast, hit, () => {
						if (++records > MAX_RECORDS) throw new GraphLimit();
					}),
				);
				return true;
			} catch (error) {
				if (error instanceof GraphLimit) return false;
				throw error;
			}
		},
	});
	const selected =
		modules
			.get(query.symbol.path)
			?.frames.filter(
				(frame) =>
					frame.location.span.start.line === query.symbol.line &&
					frame.location.span.start.column === query.symbol.column &&
					(!query.symbol.frameId || query.symbol.frameId === frame.id),
			) ?? [];
	if (selected.length !== 1)
		throw new Error(
			"Select one parsed callable frame by its exact declaration path/line/column; missing, ambiguous or outside bounded scan coverage",
		);
	const root = selected[0]!;
	if (query.symbol.contentHash && query.symbol.contentHash !== root.location.contentHash)
		throw new Error("Stale call-path symbol contentHash; re-query source symbols");
	const outgoing = new Map<string, CallEdge[]>();
	const incoming = new Map<string, CallEdge[]>();
	let unresolvedCalls = 0;
	let ambiguousCalls = 0;
	for (const module of modules.values())
		for (const call of module.calls) {
			signal?.throwIfAborted();
			const bindings = call.name ? lookup(call.scope, call.name) : undefined;
			const resolution: Resolution = module.unsafe
				? { resolution: "unresolved", provenance: "dynamic-or-unsupported-scope" }
				: !call.name
					? { resolution: "unresolved", provenance: "dynamic-member-optional-constructor-or-tagged-call" }
					: !bindings
						? { resolution: "unresolved", provenance: "no-lexical-binding-no-name-match-fallback" }
						: bindings.length !== 1
							? { resolution: "ambiguous", provenance: "multiple-lexical-declarations-no-edge" }
							: resolveBinding(bindings[0]!, module, modules);
			if (resolution.resolution === "unresolved") unresolvedCalls++;
			if (resolution.resolution === "ambiguous") ambiguousCalls++;
			const edge: CallEdge = { from: call.from, site: call.site, ...resolution, distance: 0, cycle: false };
			const out = outgoing.get(edge.from.id) ?? [];
			out.push(edge);
			outgoing.set(edge.from.id, out);
			if (edge.to) {
				const into = incoming.get(edge.to.id) ?? [];
				into.push(edge);
				incoming.set(edge.to.id, into);
			}
		}
	const order = (a: CallEdge, b: CallEdge) =>
		a.site.path < b.site.path
			? -1
			: a.site.path > b.site.path
				? 1
				: a.site.span.start.offset - b.site.span.start.offset;
	for (const edges of [...outgoing.values(), ...incoming.values()]) edges.sort(order);
	// Mark cycles by strongly-connected components, not by mistaking diamond convergence for recursion.
	const cyclic = cycleEdges(outgoing);
	const hits: CallEdge[] = [];
	const visited = new Set([root.id]);
	const queue: Array<{ frame: CallFrame; distance: number }> = [{ frame: root, distance: 0 }];
	const adjacency = query.direction === "callees" ? outgoing : incoming;
	let depthLimited = false;
	let resultLimited = false;
	let matchesObserved = 0;
	for (let index = 0; index < queue.length; index++) {
		signal?.throwIfAborted();
		const { frame, distance } = queue[index]!;
		const edges = adjacency.get(frame.id) ?? [];
		if (distance >= query.depth) {
			if (edges.length) depthLimited = true;
			continue;
		}
		for (const edge of edges) {
			matchesObserved++;
			if (hits.length >= MAX_RESULTS) {
				resultLimited = true;
				break;
			}
			hits.push({ ...edge, distance: distance + 1, cycle: cyclic.has(edge) });
			const next = query.direction === "callees" ? edge.to : edge.from;
			if (next && !visited.has(next.id)) {
				visited.add(next.id);
				queue.push({ frame: next, distance: distance + 1 });
			}
		}
		if (resultLimited) break;
	}
	const page: CallPathPage = {
		...scanned,
		mode: "source-inferred-not-runtime",
		query,
		root,
		results: [],
		coverage: {
			...scanned.coverage,
			semantics: "lexical-direct-calls-and-relative-esm",
			limitations: LIMITATIONS,
			unresolvedCalls,
			ambiguousCalls,
		},
		traversal: { depthLimited, resultLimited },
		page: { offset: 0, returned: 0, matchesObserved, retained: hits.length },
	};
	const partial = (reason: string) => {
		page.partial = true;
		if (!page.partialReasons.includes(reason)) page.partialReasons.push(reason);
	};
	if (unresolvedCalls || ambiguousCalls) partial("unresolved-or-ambiguous-calls-in-scan");
	if (depthLimited) partial("call-depth-limit");
	if (resultLimited) partial("top-1000-call-edges-only: narrow source/depth");
	page.freshness.finishedAt = new Date().toISOString();
	page.freshness.fingerprint = createHash("sha256")
		.update(JSON.stringify([scanned.freshness.fingerprint, query]))
		.digest("hex");
	paginate(page, hits, input);
	return page;
}

function cycleEdges(outgoing: Map<string, CallEdge[]>): Set<CallEdge> {
	// Iterative Kosaraju avoids a JS recursion limit on long source call chains.
	const reverse = new Map<string, string[]>();
	const vertices = new Set<string>();
	for (const [from, edges] of outgoing) {
		vertices.add(from);
		for (const edge of edges)
			if (edge.to) {
				vertices.add(edge.to.id);
				const list = reverse.get(edge.to.id) ?? [];
				list.push(from);
				reverse.set(edge.to.id, list);
			}
	}
	const visited = new Set<string>();
	const finished: string[] = [];
	for (const vertex of vertices) {
		if (visited.has(vertex)) continue;
		const stack: Array<[string, boolean]> = [[vertex, false]];
		while (stack.length) {
			const [id, done] = stack.pop()!;
			if (done) {
				finished.push(id);
				continue;
			}
			if (visited.has(id)) continue;
			visited.add(id);
			stack.push([id, true]);
			for (const edge of outgoing.get(id) ?? [])
				if (edge.to && !visited.has(edge.to.id)) stack.push([edge.to.id, false]);
		}
	}
	const components = new Map<string, number>();
	const sizes: number[] = [];
	for (const vertex of finished.reverse()) {
		if (components.has(vertex)) continue;
		const component = sizes.length;
		let size = 0;
		const stack = [vertex];
		components.set(vertex, component);
		while (stack.length) {
			const id = stack.pop()!;
			size++;
			for (const from of reverse.get(id) ?? [])
				if (!components.has(from)) {
					components.set(from, component);
					stack.push(from);
				}
		}
		sizes.push(size);
	}
	const cyclic = new Set<CallEdge>();
	for (const [from, edges] of outgoing)
		for (const edge of edges)
			if (
				edge.to &&
				components.get(from) === components.get(edge.to.id) &&
				(from === edge.to.id || sizes[components.get(from)!]! > 1)
			)
				cyclic.add(edge);
	return cyclic;
}
