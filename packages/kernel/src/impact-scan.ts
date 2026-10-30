/** Multi-source BFS over the very same bounded graph as code_call_paths. */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { CALL_LIMITATIONS, MAX_CALL_RESULTS, scanCallGraph, selectCallFrame } from "./call-graph.ts";
import type { CallFrame } from "./call-path-contract.ts";
import { paginate } from "./exploration-page.ts";
import type { ImpactHit, ImpactPage, ImpactQuery } from "./impact-contract.ts";
import type { AskContext } from "./policy.ts";
import { sourcePath } from "./source-reader.ts";

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const frameOrder = (a: CallFrame, b: CallFrame) =>
	compare(a.location.path, b.location.path) ||
	a.location.span.start.offset - b.location.span.start.offset ||
	compare(a.id, b.id);

export async function scanImpact(source: AskContext, input: ImpactQuery, signal?: AbortSignal): Promise<ImpactPage> {
	signal?.throwIfAborted();
	const query = {
		symbols: input.symbols.map((symbol) => ({ ...symbol, path: sourcePath(resolve(source.source), symbol.path) })),
		path: sourcePath(resolve(source.source), input.path ?? "."),
		depth: input.depth ?? 1,
	};
	const { scanned, modules, incoming, cyclic, unresolvedCalls, ambiguousCalls } = await scanCallGraph(
		source,
		query.path,
		signal,
	);
	if (input.expectedRevision !== undefined && input.expectedRevision !== scanned.revision.id)
		throw new Error("Stale impact source revision; re-query source call paths or impact");
	const roots = [
		...new Map(
			query.symbols.map((symbol) => {
				const frame = selectCallFrame(modules, symbol);
				return [frame.id, frame] as const;
			}),
		).values(),
	].sort(frameOrder);
	const hits: ImpactHit[] = [];
	const visited = new Set(roots.map((root) => root.id));
	const queue: ImpactHit[] = roots.map((frame) => ({ frame, rootId: frame.id, distance: 0, witness: [] }));
	let depthLimited = false;
	let resultLimited = false;
	let edgesExamined = 0;
	// All roots start at distance zero in canonical order. First discovery wins: nearest root,
	// then canonical root, then lexicographic callsite order read from root back toward caller.
	for (let index = 0; index < queue.length; index++) {
		signal?.throwIfAborted();
		const current = queue[index]!;
		const edges = incoming.get(current.frame.id) ?? [];
		if (current.distance >= query.depth) {
			if (edges.length) depthLimited = true;
			continue;
		}
		for (const edge of edges) {
			if (edgesExamined >= MAX_CALL_RESULTS) {
				resultLimited = true;
				break;
			}
			edgesExamined++;
			if (visited.has(edge.from.id)) continue;
			visited.add(edge.from.id);
			const distance = current.distance + 1;
			const hit: ImpactHit = {
				frame: edge.from,
				rootId: current.rootId,
				distance,
				witness: [{ ...edge, distance, cycle: cyclic.has(edge) }, ...current.witness],
			};
			hits.push(hit);
			queue.push(hit);
		}
		if (resultLimited) break;
	}
	const page: ImpactPage = {
		...scanned,
		mode: "source-inferred-not-runtime",
		query,
		source: {
			id: scanned.revision.sourceId,
			kind: scanned.source.kind,
			...(scanned.source.commit ? { commit: scanned.source.commit } : {}),
		},
		roots,
		results: [],
		coverage: {
			...scanned.coverage,
			semantics: "lexical-direct-calls-and-relative-esm",
			limitations: [
				...CALL_LIMITATIONS,
				"One shortest witness to a nearest root per caller, not all affected roots or paths. Counts are bounded observations; selected roots are not counted as callers.",
			],
			unresolvedCalls,
			ambiguousCalls,
		},
		capabilities: {
			callers: "bounded-source-inferred",
			valueReferences: "unsupported",
			typeRelationships: "unsupported",
			otherLanguages: "unsupported",
			runtime: "unsupported",
			completeImpact: "not-proven",
		},
		counts: {
			exhaustive: false,
			edgesExamined,
			callersObserved: hits.length,
			byRoot: roots.map((root) => ({
				rootId: root.id,
				assignedWitnesses: hits.filter((hit) => hit.rootId === root.id).length,
			})),
		},
		traversal: { depthLimited, resultLimited },
		page: { offset: 0, returned: 0, matchesObserved: hits.length, retained: hits.length },
	};
	const partial = (reason: string) => {
		page.partial = true;
		if (!page.partialReasons.includes(reason)) page.partialReasons.push(reason);
	};
	if (unresolvedCalls || ambiguousCalls) partial("unresolved-or-ambiguous-calls-in-scan");
	if (depthLimited) partial("call-depth-limit");
	if (resultLimited) partial("impact-1000-examined-edges-only: narrow source/depth");
	page.freshness.finishedAt = new Date().toISOString();
	page.freshness.fingerprint = createHash("sha256")
		.update(JSON.stringify(["impact-v1", scanned.revision.id, query, input.expectedRevision ?? null]))
		.digest("hex");
	paginate(page, hits, input);
	return page;
}
