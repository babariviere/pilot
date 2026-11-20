// Key figures and a comparison table on Pilot's own parts: a page head, one panel, sections of rows.
import { Scroll } from "nsh";
import { ComparisonTable } from "pilot-artifact/ui";
import { Block, Column, Num, Page, PageHead, Panel, Row, Rows, Section } from "pilot-day/ui";

const FIGURES = [
	{ label: "Documents", value: "4.2 M" },
	{ label: "Rebuild today", value: "47 min", note: "Search is read-only meanwhile" },
	{ label: "Peak memory", value: "3.1 GB" },
];

export default function Artifact() {
	return (
		<Scroll class="flex-1">
			<Page>
				<PageHead
					title="Search index rebuild"
					text="Three ways to rebuild without downtime. Staging run, 12 November."
				/>
				<Panel>
					<Column>
						<Section title="Staging run" note="12 Nov">
							<Rows>
								<Each of={FIGURES} key={(f) => f.label}>
									{(f) => <Row title={f().label} meta={f().note} trailing={<Num>{f().value}</Num>} />}
								</Each>
							</Rows>
						</Section>
						<Section title="Options">
							<Block>
								<ComparisonTable
									spec={{
										columns: ["Rebuild in place", "Shadow index", "Incremental"],
										recommended: 1,
										rows: [
											{ label: "Downtime", cells: ["47 min read-only", "None", "None"] },
											{ label: "Extra disk", cells: ["None", "One more index", "Small"] },
											{ label: "Rollback", cells: ["Restore backup", "Switch alias back", "Replay log"] },
											{ label: "Work", cells: ["Done today", "2 days", "1–2 weeks"] },
										],
									}}
								/>
							</Block>
						</Section>
					</Column>
				</Panel>
			</Page>
		</Scroll>
	);
}
