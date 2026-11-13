// A gallery of the examples for people reviewing the helpers (`nsh run`).
// Pilot's viewer never loads this file: it mounts one published artifact.
import { signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { mountArtifact } from "pilot-artifact/ui";
import Charts from "./examples/charts";
import Flow from "./examples/flow";
import Mockup from "./examples/mockup";
import Sequence from "./examples/sequence";
import Summary from "./examples/summary";

const EXAMPLES = [
	{ name: "Summary", view: Summary },
	{ name: "Charts", view: Charts },
	{ name: "Mockup", view: Mockup },
	{ name: "Flow", view: Flow },
	{ name: "Sequence", view: Sequence },
];

function Gallery() {
	const shown = signal(0);
	return (
		<View class="flex-1">
			<View class="flex-row gap-1 border-b border-border px-4 py-2" role="tablist">
				<Each of={EXAMPLES} key="index">
					{(example, i) => (
						<Button
							role="tab"
							selected={shown() === i()}
							onPress={() => shown.set(i())}
							class="rounded-md px-3 py-1.5 hover:bg-accent selected:bg-muted"
						>
							<Text class="text-sm text-foreground">{example().name}</Text>
						</Button>
					)}
				</Each>
			</View>
			<Each of={EXAMPLES} key="index">
				{(example, i) => (
					<If when={shown() === i()}>
						<View class="flex-1">{example().view()}</View>
					</If>
				)}
			</Each>
		</View>
	);
}

mountArtifact(Gallery);
