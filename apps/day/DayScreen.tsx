// The app's one window: Today, or one mission's overview. No sidebar; the
// mission overview has a way back, and Escape goes back too.
import type { Day } from "./day";
import { MissionScreen } from "./MissionScreen";
import { TodayScreen } from "./TodayScreen";
import { route } from "./view";

/** Today, or the mission the user opened. */
export function DayScreen(props: { day: Day }) {
	return (
		<If when={route()} else={<TodayScreen day={props.day} />}>
			<Each of={route() ? [route() as string] : []} key={(id) => id}>
				{(id) => <MissionScreen day={props.day} missionId={id()} />}
			</Each>
		</If>
	);
}
