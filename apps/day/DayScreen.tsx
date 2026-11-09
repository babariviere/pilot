// The app's one window: Today, one mission's overview, New, or one
// mission's planning. No sidebar; every other screen has a way back, and
// Escape goes back too.
import type { Day } from "./day";
import { MissionScreen } from "./MissionScreen";
import { NewScreen } from "./NewScreen";
import { PlanScreen } from "./PlanScreen";
import type { Plans } from "./planning";
import { planRoute } from "./planView";
import { TodayScreen } from "./TodayScreen";
import { route } from "./view";

/** The planning screen the user opened, if any. */
function Planning(props: { day: Day; plans: Plans }) {
	const at = () => planRoute();
	return (
		<If
			when={at()?.kind === "new"}
			else={
				<Each of={at()?.kind === "plan" ? [(at() as { missionId: string }).missionId] : []} key={(id) => id}>
					{(id) => (
						<PlanScreen
							plans={props.plans}
							missionId={id()}
							title={props.day.feed.mission(id())?.row.title ?? ""}
						/>
					)}
				</Each>
			}
		>
			<NewScreen plans={props.plans} />
		</If>
	);
}

/** Today, or the mission or planning the user opened. */
export function DayScreen(props: { day: Day; plans?: Plans }) {
	return (
		<If
			when={props.plans && planRoute()}
			else={
				<If when={route()} else={<TodayScreen day={props.day} plans={props.plans} />}>
					<Each of={route() ? [route() as string] : []} key={(id) => id}>
						{(id) => <MissionScreen day={props.day} missionId={id()} />}
					</Each>
				</If>
			}
		>
			<Planning day={props.day} plans={props.plans as Plans} />
		</If>
	);
}
