/**
 * Fixture for the native-visual versus HTML artifact benchmark (apps/macos/scripts/bench-visuals.sh): the same ten
 * charts as visual artifacts and as HTML artifacts drawing with ECharts, prepared exactly as pilotd stores them, plus
 * the ECharts bundle pilotd serves.
 *   node scripts/bench/visual-artifacts.ts <output.json>
 */
import { writeFile } from "node:fs/promises";
import { getLibraryAsset, prepareArtifact } from "../../packages/artifacts/src/render.ts";

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

/** The same chart as an agent writes it with the ECharts library, as web.md shows. */
function html(data: Chart): string {
	const series = data.series.map((s) => ({
		name: s.name,
		type: data.type === "area" ? "line" : data.type,
		areaStyle: data.type === "area" ? {} : undefined,
		stack: data.stacked ? "total" : undefined,
		data: data.type === "scatter" ? s.values.map((value, point) => [data.x[point], value]) : s.values,
	}));
	return `<h3 style="font:600 17px system-ui;margin:0 0 8px">${data.title}</h3>
<div id="chart" style="width:100%;height:220px"></div>
<script>
const chart = echarts.init(document.getElementById("chart"));
chart.setOption({
  tooltip: { trigger: "${data.type === "scatter" ? "item" : "axis"}" },
  legend: ${data.series.length > 1 ? "{}" : "{ show: false }"},
  grid: { left: 40, right: 16, top: 32, bottom: 24 },
  xAxis: ${data.type === "scatter" ? '{ type: "value" }' : `{ type: "category", data: ${JSON.stringify(data.x)} }`},
  yAxis: { type: "value", name: "ms" },
  series: ${JSON.stringify(series)},
});
addEventListener("resize", () => chart.resize());
</script>`;
}

const sessionId = "visual-bench";
const revisions: unknown[] = [];
for (let index = 0; index < 10; index++) {
	const data = chart(index);
	for (const kind of ["visual", "html"] as const) {
		const id = `${kind}-${index + 1}`;
		const write =
			kind === "visual"
				? { title: data.title, kind, source: visual, data: data as never }
				: { title: data.title, kind, source: html(data), libraries: ["echarts" as const] };
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
const echarts = (await getLibraryAsset("echarts")).source;
await writeFile(output, JSON.stringify({ revisions, libraries: { echarts } }));
console.log(`wrote ${revisions.length} revisions and ECharts (${(echarts.length / 1024).toFixed(0)} KiB) to ${output}`);
