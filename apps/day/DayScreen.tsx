// The app's one window: Today, one mission's overview, New, one mission's
// planning, Changes, or the start or end of the day. No sidebar; every
// other screen has a way back, and Escape goes back too.

import { effect, lifecycle, untracked } from "nsh";
import { ChangesScreen } from "./ChangesScreen";
import type { Changes } from "./changeFeed";
import { changesRoute } from "./changesView";
import { DeliveryScreen } from "./DeliveryScreen";
import type { Day } from "./day";
import { type DeliveryPlace, deliveryRoute } from "./deliveryView";
import { LinearScreen } from "./LinearScreen";
import { linearOpen } from "./linearView";
import { MissionScreen } from "./MissionScreen";
import { Arrive } from "./motion";
import { NewScreen } from "./NewScreen";
import { PlanScreen } from "./PlanScreen";
import type { Plans } from "./planning";
import { planRoute } from "./planView";
import { RitualScreen } from "./RitualScreen";
import { mockRituals, type Rituals } from "./ritualFeed";
import { ritualEntry, ritualRoute } from "./ritualView";
import { TodayScreen } from "./TodayScreen";
import { bindRestore, UpdateScreen } from "./UpdateScreen";
import type { Update } from "./updateFeed";
import { updateEntry, updateOpen } from "./updateView";
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

/**
 * Today, or the mission, planning, Changes, ritual or update page the user
 * opened. Without `rituals` (the mock entries), ritual progress is an
 * in-memory mock that saves nothing anywhere.
 */
export function DayScreen(props: { day: Day; plans?: Plans; changes?: Changes; update?: Update; rituals?: Rituals }) {
	updateEntry.set(props.update ?? null);
	if (props.update) bindRestore(props.update, props.changes, props.day);
	const rituals = props.rituals ?? mockRituals(props.day);
	ritualEntry.set(rituals);
	// Coming back to the window reads the saved progress again, with a fresh
	// clock sample, so a new day or time zone shows. It writes nothing.
	let was = untracked(lifecycle);
	effect(() => {
		const now = lifecycle();
		if (now === "active" && was !== "active") {
			untracked(() => {
				void rituals.refresh();
				// Results waiting for a check, looked at again. Passive.
				void props.day.delivery?.source.readSaved();
			});
		}
		was = now;
	});
	return (
		<If
			when={props.update && updateOpen()}
			else={
				<If
					when={ritualRoute()}
					else={<Screens day={props.day} rituals={rituals} plans={props.plans} changes={props.changes} />}
				>
					<RitualScreen day={props.day} rituals={rituals} />
				</If>
			}
		>
			<Arrive class="flex-1">
				<UpdateScreen update={props.update as Update} day={props.day} plans={props.plans} />
			</Arrive>
		</If>
	);
}

function Screens(props: { day: Day; rituals: Rituals; plans?: Plans; changes?: Changes }) {
	return (
		<If
			when={props.day.delivery && deliveryRoute()}
			else={
				<If
					when={props.day.linear && linearOpen()}
					else={<Places day={props.day} rituals={props.rituals} plans={props.plans} changes={props.changes} />}
				>
					<Arrive class="flex-1">
						<LinearScreen day={props.day} />
					</Arrive>
				</If>
			}
		>
			<Each of={deliveryRoute() ? [deliveryRoute() as DeliveryPlace] : []} key={(p) => p.key}>
				{(p) => (
					<Arrive class="flex-1">
						<DeliveryScreen day={props.day} place={p()} />
					</Arrive>
				)}
			</Each>
		</If>
	);
}

function Places(props: { day: Day; rituals: Rituals; plans?: Plans; changes?: Changes }) {
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
									<TodayScreen
										day={props.day}
										rituals={props.rituals}
										plans={props.plans}
										changes={props.changes}
									/>
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
