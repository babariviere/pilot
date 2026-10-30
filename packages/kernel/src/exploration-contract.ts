/** Public, bounded data contract. Worker imports these types only, not the SDK. */
import { type Static, Type } from "@earendil-works/pi-ai";

const Position = Type.Object({ offset: Type.Integer(), line: Type.Integer(), column: Type.Integer() });
const Span = Type.Object({ start: Position, end: Position });
export const SourceRevision = Type.Object({
	id: Type.String(),
	sourceId: Type.String(),
	kind: Type.Union([Type.Literal("observed-content"), Type.Literal("pinned-content")]),
	engine: Type.String(),
	consistency: Type.Literal("per-file-read-not-atomic"),
});
export const ExplorationOutput = Type.Object({
	version: Type.Literal(1),
	revision: SourceRevision,
	query: Type.Object({
		tool: Type.Union([Type.Literal("code_search"), Type.Literal("code_symbols")]),
		query: Type.String(),
		path: Type.String(),
		exact: Type.Boolean(),
	}),
	source: Type.Object({ root: Type.String(), kind: Type.String(), commit: Type.Optional(Type.String()) }),
	freshness: Type.Object({
		startedAt: Type.String(),
		finishedAt: Type.String(),
		fingerprint: Type.String(),
		consistency: Type.Literal("per-file-read-not-atomic"),
		includesUncommitted: Type.Boolean(),
	}),
	coverage: Type.Object({
		parsed: Type.Integer(),
		lexical: Type.Integer(),
		unsupported: Type.Integer(),
		semantics: Type.Literal("named-declarations-not-reference-resolution"),
		parser: Type.String(),
	}),
	scan: Type.Object({ files: Type.Integer(), bytes: Type.Integer(), entries: Type.Integer() }),
	exclusions: Type.Record(Type.String(), Type.Integer()),
	exclusionPolicy: Type.Array(Type.String()),
	failures: Type.Array(Type.Object({ path: Type.String(), reason: Type.String() })),
	failureCount: Type.Integer(),
	partial: Type.Boolean(),
	partialReasons: Type.Array(Type.String()),
	results: Type.Array(
		Type.Object({
			path: Type.String(),
			citation: Type.String(),
			contentHash: Type.String(),
			span: Span,
			snippet: Type.Object({ text: Type.String(), span: Span, truncated: Type.Boolean() }),
			coverage: Type.Union([Type.Literal("parsed"), Type.Literal("lexical")]),
			score: Type.Integer(),
			name: Type.Optional(Type.String()),
			nameTruncated: Type.Optional(Type.Boolean()),
			kind: Type.Optional(Type.String()),
			container: Type.Optional(Type.String()),
			containerTruncated: Type.Optional(Type.Boolean()),
		}),
	),
	page: Type.Object({
		offset: Type.Integer(),
		returned: Type.Integer(),
		matchesObserved: Type.Integer(),
		retained: Type.Integer(),
		nextCursor: Type.Optional(Type.String()),
	}),
});

export type ExplorationPage = Static<typeof ExplorationOutput>;
export type SourceHit = ExplorationPage["results"][number];
export interface ExplorationQuery {
	tool: "code_search" | "code_symbols";
	query?: string;
	path?: string;
	exact?: boolean;
	limit?: number;
	cursor?: string;
}
