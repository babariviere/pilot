// A bar chart, a trend and a timeline.
import { BarChart, Card, Page, Section, Timeline, TrendChart } from "pilot-artifact/ui";

export default function Artifact() {
	return (
		<Page title="Test suite health" subtitle="Last 14 days on main.">
			<Section title="Slowest packages">
				<BarChart
					spec={{
						unit: "s",
						bars: [
							{ label: "daemon", value: 212 },
							{ label: "kernel", value: 148 },
							{ label: "artifacts", value: 41 },
							{ label: "protocol", value: 6.5 },
						],
					}}
				/>
			</Section>
			<Section title="Full run time">
				<Card>
					<TrendChart
						spec={{
							unit: "min",
							points: [
								{ label: "30 Oct", value: 11.2 },
								{ label: "1 Nov", value: 11.8 },
								{ label: "3 Nov", value: 12.6 },
								{ label: "5 Nov", value: 14.1 },
								{ label: "7 Nov", value: 13.9 },
								{ label: "9 Nov", value: 9.4 },
								{ label: "11 Nov", value: 9.1 },
								{ label: "12 Nov", value: 8.8 },
							],
						}}
					/>
				</Card>
			</Section>
			<Section title="Plan">
				<Timeline
					spec={{
						events: [
							{ when: "5 Nov", title: "Split integration tests", state: "done" },
							{ when: "9 Nov", title: "Run packages in parallel", state: "done" },
							{
								when: "This week",
								title: "Cache fixtures",
								detail: "Saves about a minute per run.",
								state: "now",
							},
							{ when: "Later", title: "Remove the slowest daemon test", state: "next" },
						],
					}}
				/>
			</Section>
		</Page>
	);
}
