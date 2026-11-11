// The date line on Today, with the ritual of the moment and the standup
// notes. A quiet offer, never a reminder: once the user goes through or
// skips a ritual, and that is saved, Today stops offering it for that day.
// Showing Today records that the user looked, once for each day; reading or
// opening Pilot in the background does not.
import { effect, lifecycle, Text, untracked, View } from "nsh";
import type { RitualSnapshot } from "pilot-day/native";
import type { Day } from "./day";
import type { Rituals } from "./ritualFeed";
import { offered, openRitual, openStandup } from "./ritualView";
import { Action, Mark } from "./ui";

/** Why Today offers no start or end of day, when its saved progress cannot say. */
function progressLine(progress: RitualSnapshot, uncertain: boolean): string {
	if (uncertain || progress.availability === "unknown") {
		return "Pilot could not confirm the last start or end of day was saved. It will not save it again.";
	}
	if (progress.availability === "unavailable") {
		return "Start and end of day are not available: Pilot cannot read the local day here.";
	}
	return "";
}

/** Today's date line, the start or end of day when it fits, and the standup notes. */
export function DayLine(props: { day: Day; rituals: Rituals }) {
	const today = () => props.day.today();
	const r = props.rituals;
	const ritual = () => offered(today(), r.progress(), r.uncertain());
	const note = () => progressLine(r.progress(), r.uncertain());
	// Today is on screen, readable and in front: that is a visit. The store
	// sends it once for each day context and never resends a lost one.
	effect(() => {
		const progress = r.progress();
		if (lifecycle() !== "active" || today().freshness.state === "unreadable") return;
		if (progress.availability !== "available") return;
		untracked(() => void r.visit());
	});
	return (
		<View class="gap-1.5">
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
			<If when={note()}>
				<View testID="ritual-progress" class="flex-row flex-wrap items-center gap-x-2 gap-y-1">
					<Mark kind="unknown" />
					<Text class="text-xs text-muted-foreground">{note()}</Text>
					<If when={r.uncertain() || r.progress().availability === "unknown"}>
						<Action label="Read again" testID="ritual-read" onPress={() => void r.refresh()} />
					</If>
				</View>
			</If>
		</View>
	);
}
