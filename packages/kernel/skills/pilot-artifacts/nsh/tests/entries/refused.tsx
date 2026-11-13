// Data the helpers must refuse with a reason, never draw in part.
import {
	BarChart,
	ComparisonTable,
	FlowDiagram,
	type FlowSpec,
	mountArtifact,
	Page,
	SequenceDiagram,
	TrendChart,
} from "pilot-artifact/ui";

const tooMany: FlowSpec = {
	nodes: Array.from({ length: 41 }, (_, i) => ({ id: `n${i}`, label: `Step ${i}` })),
};

function Refused() {
	return (
		<Page title="Refused data">
			<FlowDiagram spec={{ nodes: [{ id: "a", label: "Start" }], edges: [{ from: "a", to: "missing" }] }} />
			<FlowDiagram spec={tooMany} />
			<SequenceDiagram
				spec={{ participants: [{ id: "a", label: "A" }], steps: [{ from: "a", to: "b", label: "hi" }] }}
			/>
			<BarChart spec={{ bars: [{ label: "Loss", value: -3 }] }} />
			<TrendChart spec={{ points: [{ label: "only", value: 1 }] }} />
			<ComparisonTable spec={{ columns: ["A", "B"], rows: [{ label: "Cost", cells: ["1"] }] }} />
			<FlowDiagram spec={JSON.parse('{"nodes":"not a list"}')} />
		</Page>
	);
}

mountArtifact(Refused);
