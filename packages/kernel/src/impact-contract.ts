/** Bounded reverse-call witnesses, never complete change impact or runtime evidence. */
import { type Static, Type } from "@earendil-works/pi-ai";
import { CallPathOutput, CallSymbol, Frame } from "./call-path-contract.ts";

export const ImpactOutput = Type.Object({
	...Type.Omit(CallPathOutput, ["query", "source", "root", "results"]).properties,
	query: Type.Object({ symbols: Type.Array(CallSymbol), path: Type.String(), depth: Type.Integer() }),
	source: Type.Object({ id: Type.String(), kind: Type.String(), commit: Type.Optional(Type.String()) }),
	roots: Type.Array(Frame),
	capabilities: Type.Object({
		callers: Type.Literal("bounded-source-inferred"),
		valueReferences: Type.Literal("unsupported"),
		typeRelationships: Type.Literal("unsupported"),
		otherLanguages: Type.Literal("unsupported"),
		runtime: Type.Literal("unsupported"),
		completeImpact: Type.Literal("not-proven"),
	}),
	counts: Type.Object({
		exhaustive: Type.Literal(false),
		edgesExamined: Type.Integer(),
		callersObserved: Type.Integer(),
		byRoot: Type.Array(Type.Object({ rootId: Type.String(), assignedWitnesses: Type.Integer() })),
	}),
	results: Type.Array(
		Type.Object({
			frame: Frame,
			rootId: Type.String(),
			distance: Type.Integer(),
			witness: Type.Array(CallPathOutput.properties.results.items),
		}),
	),
});
export type ImpactPage = Static<typeof ImpactOutput>;
export type ImpactHit = ImpactPage["results"][number];
export interface ImpactQuery {
	tool: "code_impact";
	symbols: Static<typeof CallSymbol>[];
	path?: string;
	depth?: number;
	limit?: number;
	cursor?: string;
	expectedRevision?: string;
}
