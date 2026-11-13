// Synthetic passive attention only. No daemon, filesystem or retry authority.
import { mount, Text, View } from "nsh";
import { openDay } from "./day";
import { MockDayScreen } from "./mockFeeds";
import { Action } from "./ui";

const day = openDay();
day.today.update((t) => ({
	...t,
	problemsKnown: true,
	problems: [
		{
			id: "failed-worker",
			title: "History work stopped",
			cause: "Native checks failed. The coordinator needs your help.",
			nextStep: "Inspect the failed check before choosing how to continue. Nothing is retried here.",
			workState: "Saved work is not verified. Unfinished effects may be uncertain.",
			missionId: "native",
			chatLink: "pilot://chat/fixture-worker",
		},
	],
}));

mount(() => (
	<View class="flex-1 bg-background">
		<MockDayScreen day={day} />
		<View class="flex-row border-t border-border px-6 py-2">
			<Action
				label="Stale read"
				onPress={() => day.today.update((t) => ({ ...t, freshness: { ...t.freshness, state: "offline" } }))}
			/>
			<Action label="Resolve problems" onPress={() => day.today.update((t) => ({ ...t, problems: [] }))} />
			<Action label="Missing attention" onPress={() => day.today.update((t) => ({ ...t, problemsKnown: false }))} />
			<Text class="text-xs text-faint">Synthetic read. No effects.</Text>
		</View>
	</View>
));
