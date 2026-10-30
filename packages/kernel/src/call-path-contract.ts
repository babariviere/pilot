/** Source relationships only, never an observed runtime stack. */
import { type Static, Type } from "@earendil-works/pi-ai";
import { ExplorationOutput } from "./exploration-contract.ts";

export const CallSymbol = Type.Object({
	path: Type.String({ maxLength: 4096 }),
	line: Type.Integer({ minimum: 1 }),
	column: Type.Integer({ minimum: 1 }),
	contentHash: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
	frameId: Type.Optional(Type.String({ maxLength: 4400 })),
});
export const Frame = Type.Object({
	id: Type.String(),
	name: Type.String(),
	nameTruncated: Type.Boolean(),
	kind: Type.String(),
	location: ExplorationOutput.properties.results.items,
});
export const CallPathOutput = Type.Object({
	version: Type.Literal(1),
	mode: Type.Literal("source-inferred-not-runtime"),
	query: Type.Object({
		symbol: CallSymbol,
		direction: Type.Union([Type.Literal("callers"), Type.Literal("callees")]),
		depth: Type.Integer(),
		path: Type.String(),
	}),
	source: ExplorationOutput.properties.source,
	revision: ExplorationOutput.properties.revision,
	freshness: ExplorationOutput.properties.freshness,
	coverage: Type.Object({
		parsed: Type.Integer(),
		lexical: Type.Integer(),
		unsupported: Type.Integer(),
		parser: Type.String(),
		semantics: Type.Literal("lexical-direct-calls-and-relative-esm"),
		limitations: Type.Array(Type.String()),
		unresolvedCalls: Type.Integer(),
		ambiguousCalls: Type.Integer(),
	}),
	scan: ExplorationOutput.properties.scan,
	exclusions: ExplorationOutput.properties.exclusions,
	exclusionPolicy: ExplorationOutput.properties.exclusionPolicy,
	failures: ExplorationOutput.properties.failures,
	failureCount: Type.Integer(),
	partial: Type.Boolean(),
	partialReasons: Type.Array(Type.String()),
	root: Frame,
	results: Type.Array(
		Type.Object({
			from: Frame,
			to: Type.Optional(Frame),
			site: ExplorationOutput.properties.results.items,
			resolution: Type.Union([
				Type.Literal("resolved"),
				Type.Literal("inferred"),
				Type.Literal("ambiguous"),
				Type.Literal("unresolved"),
			]),
			provenance: Type.String(),
			distance: Type.Integer(),
			cycle: Type.Boolean(),
		}),
	),
	traversal: Type.Object({ depthLimited: Type.Boolean(), resultLimited: Type.Boolean() }),
	page: ExplorationOutput.properties.page,
});
export type CallPathPage = Static<typeof CallPathOutput>;
export type CallFrame = CallPathPage["root"];
export type CallEdge = CallPathPage["results"][number];
export interface CallPathQuery {
	tool: "code_call_paths";
	symbol: Static<typeof CallSymbol>;
	direction: "callers" | "callees";
	depth?: number;
	path?: string;
	limit?: number;
	cursor?: string;
}
