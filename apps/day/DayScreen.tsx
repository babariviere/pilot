// The app's one window: Today, one mission's overview, New, one mission's
// planning, Changes, or the start or end of the day. No sidebar; every
// other screen has a way back, and Escape goes back too.

import { ChangesScreen } from "./ChangesScreen";
import type { Changes } from "./changeFeed";
import { changesRoute } from "./changesView";
import type { Day } from "./day";
import { MissionScreen } from "./MissionScreen";
import { Arrive } from "./motion";
import { NewScreen } from "./NewScreen";
import { PlanScreen } from "./PlanScreen";
import type { Plans } from "./planning";
import { planRoute } from "./planView";
import { RitualScreen } from "./RitualScreen";
import { ritualRoute } from "./ritualView";
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
						<Arrive class="flex-1">
							<PlanScreen
								day={props.day}
								plans={props.plans}
								missionId={id()}
								title={props.day.feed.mission(id())?.row.title ?? ""}
							/>
						</Arrive>
					)}
				</Each>
			}
		>
			<Arrive class="flex-1">
				<NewScreen plans={props.plans} />
			</Arrive>
		</If>
	);
}

/** Today, or the mission, planning, Changes or ritual the user opened. */
export function DayScreen(props: { day: Day; plans?: Plans; changes?: Changes }) {
	return (
		<If when={ritualRoute()} else={<Screens day={props.day} plans={props.plans} changes={props.changes} />}>
			<RitualScreen day={props.day} />
		</If>
	);
}

function Screens(props: { day: Day; plans?: Plans; changes?: Changes }) {
	return (
		<If
			when={props.changes && changesRoute()}
			else={
				<If
					when={props.plans && planRoute()}
					else={
						<If
							when={route()}
							else={
								<Arrive class="flex-1">
									<TodayScreen day={props.day} plans={props.plans} changes={props.changes} />
								</Arrive>
							}
						>
							<Each of={route() ? [route() as string] : []} key={(id) => id}>
								{(id) => (
									<Arrive class="flex-1">
										<MissionScreen day={props.day} plans={props.plans} missionId={id()} />
									</Arrive>
								)}
							</Each>
						</If>
					}
				>
					<Planning day={props.day} plans={props.plans as Plans} />
				</If>
			}
		>
			<ChangesScreen changes={props.changes as Changes} />
		</If>
	);
}
