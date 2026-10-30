/** One bounded shared source scan per graph query, not per traversed frame. */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { CALL_LIMITATIONS, MAX_CALL_RESULTS, scanCallGraph, selectCallFrame } from "./call-graph.ts";
import type { CallEdge, CallFrame, CallPathPage, CallPathQuery } from "./call-path-contract.ts";
import { paginate } from "./exploration-page.ts";
import type { AskContext } from "./policy.ts";
import { sourcePath } from "./source-reader.ts";

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
	const { scanned, modules, outgoing, incoming, cyclic, unresolvedCalls, ambiguousCalls } = await scanCallGraph(
		source,
		query.path,
		signal,
	);
	const root = selectCallFrame(modules, query.symbol);
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
			if (hits.length >= MAX_CALL_RESULTS) {
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
			limitations: CALL_LIMITATIONS,
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
