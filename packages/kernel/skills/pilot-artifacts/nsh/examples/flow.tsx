// An architecture or process diagram: steps and links, laid out for you.
import { FlowDiagram, Page, Section } from "pilot-artifact/ui";

export default function Artifact() {
	return (
		<Page title="How a change ships" subtitle="From request to review. The loop repeats until checks pass.">
			<Section title="Flow">
				<FlowDiagram
					spec={{
						direction: "right",
						nodes: [
							{ id: "ask", label: "Request", detail: "From Today or a mission" },
							{ id: "plan", label: "Plan" },
							{ id: "build", label: "Build in a workspace", tone: "accent" },
							{ id: "check", label: "Checks", detail: "Lint and affected tests" },
							{ id: "review", label: "Ready for you to check" },
						],
						edges: [
							{ from: "ask", to: "plan" },
							{ from: "plan", to: "build" },
							{ from: "build", to: "check" },
							{ from: "check", to: "review", label: "pass" },
							{ from: "check", to: "build", label: "fix", dashed: true },
						],
					}}
				/>
			</Section>
		</Page>
	);
}
