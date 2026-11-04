/** Native chart fixtures only. The former HTML comparison is retired. */
import { writeFile } from "node:fs/promises";
import { prepareArtifact } from "../../packages/artifacts/src/render.ts";

const output = process.argv[2];
if (!output) throw new Error("usage: visual-artifacts.ts <output.json>");

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const kinds = ["bar", "line", "area", "scatter"] as const;

interface Chart {
	title: string;
	type: (typeof kinds)[number];
	x: Array<string | number>;
	series: Array<{ name: string; values: number[] }>;
	stacked?: boolean;
}

function chart(index: number): Chart {
	const type = kinds[index % kinds.length]!;
	const x = type === "scatter" ? months.map((_, point) => point * 3 + (index % 3)) : months;
	const count = index % 3 === 2 ? 1 : 2;
	const series = Array.from({ length: count }, (_, s) => ({
		name: s === 0 ? "p95" : "p99",
		values: months.map((_, point) => Math.round(120 + 60 * Math.sin(point / 2 + index + s) + 25 * s + index * 7)),
	}));
	return {
		title: `Latency ${index + 1}: ${type}`,
		type,
		x,
		series,
		stacked: type === "bar" && count > 1 ? true : undefined,
	};
}

/** One visual function for every chart; the chart is the data. */
const visual = `function visual({ ui, data }) {
  return () =>
    ui.column({ gap: 8 }, [
      ui.text(data.title, { size: "lg", weight: 600 }),
      ui.chart({ type: data.type, height: 220, unit: "ms", x: data.x, series: data.series, stacked: data.stacked }),
    ]);
}`;

const sessionId = "visual-bench";
const revisions: unknown[] = [];
for (let index = 0; index < 10; index++) {
	const data = chart(index);
	{
		const kind = "visual";
		const id = `${kind}-${index + 1}`;
		const write = { title: data.title, kind: "visual" as const, source: visual, data: data as never };
		const prepared = await prepareArtifact(write, { id });
		revisions.push({
			id,
			sessionId,
			title: data.title,
			kind,
			revision: 1,
			createdAt: 1,
			updatedAt: 1,
			source: write.source,
			html: prepared.html,
			libraries: prepared.libraries,
			...(kind === "visual" ? { data, visual: prepared.visual } : {}),
		});
	}
}
await writeFile(output, JSON.stringify({ revisions, libraries: {} }));
console.log(`wrote ${revisions.length} native revisions to ${output}`);
