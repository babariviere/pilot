// Summary cards and a comparison table.
import { View } from "nsh";
import { ComparisonTable, Page, Section, Stat } from "pilot-artifact/ui";

export default function Artifact() {
	return (
		<Page title="Search index rebuild" subtitle="Three ways to rebuild without downtime. Staging run, 12 November.">
			<View class="flex-row flex-wrap gap-3">
				<Stat label="Documents" value="4.2 M" />
				<Stat label="Rebuild today" value="47 min" note="Search is read-only meanwhile" />
				<Stat label="Peak memory" value="3.1 GB" />
			</View>
			<Section title="Options">
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
			</Section>
		</Page>
	);
}
