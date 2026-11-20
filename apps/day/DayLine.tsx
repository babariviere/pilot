// Today's date, the ritual of the moment and the standup notes. A quiet offer, never a reminder: once the user
// goes through or skips a ritual, and that is saved, Today stops offering it for that day. Showing Today records
// that the user looked, once for each day; reading or opening Pilot in the background does not.
// The date sits above Today's title, the buttons at the right of its head, the notes under its summary.
import { effect, lifecycle, untracked } from "nsh";
import type { RitualSnapshot } from "pilot-day/native";
import type { Day } from "./day";
import type { Rituals } from "./ritualFeed";
import { offered, openRitual, openStandup } from "./ritualView";
import { Button, Link, Notice, Num } from "./ui";

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

/**
 * Today is on screen, readable and in front: that is a visit. The store sends it once for each day context and
 * never resends a lost one.
 */
export function visitToday(day: Day, rituals: Rituals) {
	effect(() => {
		const progress = rituals.progress();
		if (lifecycle() !== "active" || day.today().freshness.state === "unreadable") return;
		if (progress.availability !== "available") return;
		untracked(() => void rituals.visit());
	});
}

/** Today's date line, above its title. */
export function DayDate(props: { day: Day }) {
	return <Num>{props.day.today().dateLine}</Num>;
}

/** The start or end of day when it fits, and the standup notes. */
export function DayActions(props: { day: Day; rituals: Rituals }) {
	const r = props.rituals;
	const ritual = () => offered(props.day.today(), r.progress(), r.uncertain());
	return (
		<>
			<If when={!props.day.search && ritual() === "start"}>
				<Button label="Start the day" icon="sun" testID="start-day" onPress={() => openRitual("start")} />
			</If>
			<If when={!props.day.search && ritual() === "end"}>
				<Button label="End the day" icon="moon" testID="end-day" onPress={() => openRitual("end")} />
			</If>
			<Button
				label={props.day.search ? "Plan or recap" : "Standup notes"}
				icon="notes"
				testID="standup"
				onPress={() => openStandup(null)}
			/>
		</>
	);
}

/** Under Today's summary: why no start or end of day is offered. */
export function DayNotes(props: { day: Day; rituals: Rituals }) {
	const r = props.rituals;
	const note = () => progressLine(r.progress(), r.uncertain());
	return (
		<If when={!props.day.search && note()}>
			<Notice
				testID="ritual-progress"
				text={note()}
				action={
					<If when={r.uncertain() || r.progress().availability === "unknown"}>
						<Link label="Read again" testID="ritual-read" onPress={() => void r.refresh()} />
					</If>
				}
			/>
		</If>
	);
}
