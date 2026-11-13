// A sequence diagram: who sends what to whom, in order.
import { Page, Section, SequenceDiagram } from "pilot-artifact/ui";

export default function Artifact() {
	return (
		<Page title="Saving a draft before an update" subtitle="What happens when you press Update.">
			<Section title="Sequence">
				<SequenceDiagram
					spec={{
						participants: [
							{ id: "you", label: "You" },
							{ id: "app", label: "Pilot" },
							{ id: "daemon", label: "Background service" },
						],
						steps: [
							{ from: "you", to: "app", label: "Press Update" },
							{ from: "app", to: "app", label: "Save open drafts" },
							{ from: "app", to: "daemon", label: "Pause chats" },
							{ note: "Running tools stop at a safe point", over: "daemon" },
							{ from: "daemon", to: "app", label: "Paused", reply: true },
							{ from: "app", to: "you", label: "Restart with drafts kept", reply: true },
						],
					}}
				/>
			</Section>
		</Page>
	);
}
