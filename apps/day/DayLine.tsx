// The date line on Today, with the ritual of the moment and the standup
// notes. A quiet offer, never a reminder: once the user goes through or
// skips a ritual, Today stops offering it for that day.
import { Text, View } from "nsh";
import type { Day } from "./day";
import { offered, openRitual, openStandup } from "./ritualView";
import { Action } from "./ui";

/** Today's date line, the start or end of day when it fits, and the standup notes. */
export function DayLine(props: { day: Day }) {
	const today = () => props.day.today();
	const ritual = () => offered(today());
	return (
		<View class="flex-row flex-wrap items-center gap-x-2 gap-y-1">
			<Text class="pr-1 text-xs text-muted-foreground">{today().dateLine}</Text>
			<If when={ritual() === "start"}>
				<Action label="Start the day" testID="start-day" onPress={() => openRitual("start")} />
			</If>
			<If when={ritual() === "end"}>
				<Action label="End the day" testID="end-day" onPress={() => openRitual("end")} />
			</If>
			<Action label="Standup notes" testID="standup" onPress={() => openStandup(null)} />
		</View>
	);
}
