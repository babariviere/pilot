// The app's one window: Today, one mission's overview, New, one mission's
// planning, Changes, Settings, Feedback, or the start or end of the day. No sidebar. One header
// stays over every screen: Pilot goes to Today, Back goes up one level,
// and Escape goes back too.

import { cleanup, computed, effect, lifecycle, untracked, View } from "nsh";
import { FullArtifact } from "./ArtifactShelf";
import { ArtifactsScreen } from "./ArtifactsScreen";
import type { ArtifactSource } from "./artifactReads";
import { ChangesScreen } from "./ChangesScreen";
import { ChatScreen } from "./ChatScreen";
import { AppHeader } from "./Chrome";
import type { Changes } from "./changeFeed";
import { chatRoute } from "./chatView";
import { DeliveryScreen } from "./DeliveryScreen";
import type { Day } from "./day";
import { type DeliveryPlace, deliveryRoute } from "./deliveryView";
import { FeedbackScreen } from "./FeedbackScreen";
import { LinearScreen } from "./LinearScreen";
import { SlackReportsScreen } from "./SlackReportsScreen";
import { MissionScreen } from "./MissionScreen";
import { NewScreen } from "./NewScreen";
import { animatePlanningList, type Shown, shown } from "./nav";
import { PlanScreen } from "./PlanScreen";
import type { Plans } from "./planning";
import { planRoute } from "./planView";
import { RitualScreen } from "./RitualScreen";
import type { Rituals } from "./ritualFeed";
import { ritualEntry } from "./ritualView";
import { SettingsScreen } from "./SettingsScreen";
import { ThreadScreen } from "./ThreadScreen";
import { TodayScreen } from "./TodayScreen";
import { threadRoute } from "./threadView";
import { bindRestore, UpdateScreen } from "./UpdateScreen";
import { Arrive } from "./ui";
import type { Update } from "./updateFeed";
import { updateEntry } from "./updateView";
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
				<NewScreen plans={props.plans} day={props.day} />
			</Arrive>
		</If>
	);
}

/**
 * Today, or the mission, planning, Changes, ritual or update page the user
 * opened. Every feed comes from the caller; this screen invents no data.
 */
export function DayScreen(props: { day: Day; plans?: Plans; changes?: Changes; update?: Update; rituals: Rituals }) {
	updateEntry.set(props.update ?? null);
	if (props.update) bindRestore(props.update, props.changes, props.day);
	const rituals = props.rituals;
	const at = computed(() => shown(props));
	const plans = props.plans;
	if (plans) {
		// Own this subscription with the surface, before its next native commit.
		cleanup(animatePlanningList(plans, () => untracked(at)));
	}
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
		<View class="flex-1 bg-background">
			<AppHeader day={props.day} plans={props.plans} changes={props.changes} />
			<View class="min-h-0 flex-1">
				<If
					when={at() === "update"}
					else={
						<If
							when={at() === "ritual"}
							else={
								<Screens
									at={at()}
									day={props.day}
									rituals={rituals}
									plans={props.plans}
									changes={props.changes}
								/>
							}
						>
							<Arrive class="flex-1">
								<RitualScreen day={props.day} rituals={rituals} />
							</Arrive>
						</If>
					}
				>
					<Arrive class="flex-1">
						<UpdateScreen update={props.update as Update} day={props.day} plans={props.plans} />
					</Arrive>
				</If>
				{/* One artifact in the whole window, over any page. Hidden until opened there. */}
				<FullArtifact />
			</View>
		</View>
	);
}

function Screens(props: { at: Shown; day: Day; rituals: Rituals; plans?: Plans; changes?: Changes }) {
	return (
		<If
			when={props.at === "chat"}
			else={
				<If
					when={props.at === "settings"}
					else={
						<If
							when={props.at === "feedback"}
							else={
								<Results
									at={props.at}
									day={props.day}
									rituals={props.rituals}
									plans={props.plans}
									changes={props.changes}
								/>
							}
						>
							<Arrive class="flex-1">
								<FeedbackScreen day={props.day} />
							</Arrive>
						</If>
					}
				>
					<Arrive class="flex-1">
						<SettingsScreen day={props.day} />
					</Arrive>
				</If>
			}
		>
			<Each of={chatRoute() ? [chatRoute()?.sessionId as string] : []} key={(id) => id}>
				{(id) => (
					<Arrive class="flex-1">
						<ChatScreen day={props.day} sessionId={id()} />
					</Arrive>
				)}
			</Each>
		</If>
	);
}

function Results(props: { at: Shown; day: Day; rituals: Rituals; plans?: Plans; changes?: Changes }) {
	return (
		<If when={props.at === "slack"} else={<OtherResults {...props} />}>
			<Arrive class="flex-1">
				<SlackReportsScreen day={props.day} />
			</Arrive>
		</If>
	);
}

function OtherResults(props: { at: Shown; day: Day; rituals: Rituals; plans?: Plans; changes?: Changes }) {
	return (
		<If
			when={props.at === "delivery"}
			else={
				<If
					when={props.at === "linear"}
					else={
						<If
							when={props.at === "artifacts"}
							else={
								<Places
									at={props.at}
									day={props.day}
									rituals={props.rituals}
									plans={props.plans}
									changes={props.changes}
								/>
							}
						>
							<Arrive class="flex-1">
								<ArtifactsScreen source={props.day.artifacts as ArtifactSource} />
							</Arrive>
						</If>
					}
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

function Places(props: { at: Shown; day: Day; rituals: Rituals; plans?: Plans; changes?: Changes }) {
	return (
		<If
			when={["change", "changes"].includes(props.at)}
			else={
				<If
					when={["new", "plan"].includes(props.at)}
					else={
						<If
							when={["mission", "thread"].includes(props.at)}
							else={
								<Arrive class="flex-1">
									<TodayScreen day={props.day} rituals={props.rituals} plans={props.plans} />
								</Arrive>
							}
						>
							<Each of={route() ? [route() as string] : []} key={(id) => id}>
								{(id) => (
									<If
										when={props.at === "thread"}
										else={
											<Arrive class="flex-1">
												<MissionScreen day={props.day} plans={props.plans} missionId={id()} />
											</Arrive>
										}
									>
										<Each of={threadRoute() ? [threadRoute()?.topicId as string] : []} key={(t) => t}>
											{(t) => (
												<Arrive class="flex-1">
													<ThreadScreen day={props.day} missionId={id()} topicId={t()} />
												</Arrive>
											)}
										</Each>
									</If>
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
