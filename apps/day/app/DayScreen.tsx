// The app's one window: Today, one mission's overview, New, one mission's
// planning, Changes, Settings, Feedback, or the start or end of the day. No sidebar. One header
// stays over every screen: Pilot goes to Today, Back goes up one level,
// and Escape goes back too.

import { cleanup, computed, effect, lifecycle, untracked, View } from "nsh";
import { FullArtifact } from "../artifacts/ArtifactShelf";
import { ArtifactsScreen } from "../artifacts/ArtifactsScreen";
import type { ArtifactSource } from "../artifacts/artifactReads";
import { ChangesScreen } from "../changes/ChangesScreen";
import type { Changes } from "../changes/changeFeed";
import { FeedbackScreen } from "../feedback/FeedbackScreen";
import { InsightsScreen } from "../insights/InsightsScreen";
import { canDraftInsight, hasOtherDraft, openFindingDraft } from "../insights/insightsWork";
import { DeliveryScreen } from "../missions/delivery/DeliveryScreen";
import { type DeliveryPlace, deliveryRoute } from "../missions/delivery/deliveryView";
import { NewScreen } from "../missions/intake/NewScreen";
import { ScopedQuestion, scopedQuestion } from "../missions/interviews/ScopedQuestion";
import { MissionScreen } from "../missions/MissionScreen";
import { PlanScreen } from "../missions/planning/PlanScreen";
import type { Plans } from "../missions/planning/planning";
import { planRoute } from "../missions/planning/planView";
import { SearchDetailScreen } from "../search/SearchDetailScreen";
import { type DetailHit, searchDetail, type WorkSearchSource } from "../search/workSearch";
import { ChatScreen } from "../sessions/ChatScreen";
import { chatRoute, openChat } from "../sessions/chatView";
import { ThreadScreen } from "../sessions/ThreadScreen";
import { threadRoute } from "../sessions/threadView";
import { SettingsScreen } from "../settings/SettingsScreen";
import { LinearScreen } from "../sources/linear/LinearScreen";
import { SlackReportsScreen } from "../sources/slack/SlackReportsScreen";
import { RitualScreen } from "../today/rituals/RitualScreen";
import type { Rituals } from "../today/rituals/ritualFeed";
import { ritualEntry } from "../today/rituals/ritualView";
import { TodayScreen } from "../today/TodayScreen";
import { todayProject } from "../today/todayScope";
import { Arrive, Notice, WindowCanvas } from "../ui";
import { bindRestore, UpdateScreen } from "../updates/UpdateScreen";
import type { Update } from "../updates/updateFeed";
import { updateEntry } from "../updates/updateView";
import { AppHeader } from "./Chrome";
import type { Day } from "./day";
import {
	animatePlanningList,
	jumpBack,
	navigationError,
	navigationRestoring,
	type Shown,
	shown,
	type Places as WindowPlaces,
} from "./nav";
import { route } from "./view";

function backFromJump(places: WindowPlaces) {
	return () => {
		const back = jumpBack(places);
		if (!back) return false;
		back.go();
		return true;
	};
}

/** The planning screen the user opened, if any. */
function Planning(props: { day: Day; plans: Plans }) {
	const at = () => planRoute();
	const interviewProject = () => {
		const route = at();
		return route?.kind === "plan" ? route.fromInterviewProject : undefined;
	};
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
								interviewProject={interviewProject()}
								title={props.day.feed.mission(id())?.row.title ?? ""}
								onBackFromJump={backFromJump(props)}
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
				// Today's service read too, at most every 30 s (freshness.ts).
				props.day.freshness?.focus();
				props.day.insights?.focus();
				void rituals.refresh();
				// Results waiting for a check, looked at again. Passive.
				void props.day.delivery?.source.readSaved();
			});
		}
		was = now;
	});
	return (
		<WindowCanvas>
			<AppHeader day={props.day} plans={props.plans} changes={props.changes} />
			<If when={navigationError()}>
				<Notice text={navigationError()} placement="panel" />
			</If>
			<If when={navigationRestoring()}>
				<Notice text="Returning to the previous project…" placement="panel" />
			</If>
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
		</WindowCanvas>
	);
}

function Screens(props: { at: Shown; day: Day; rituals: Rituals; plans?: Plans; changes?: Changes }) {
	return (
		<If
			when={props.at === "search-detail"}
			else={
				<If when={props.at === "scoped-question"} else={<MainScreens {...props} />}>
					<If when={scopedQuestion()}>
						{(place) => (
							<ScopedQuestion
								place={place()}
								onBack={() => backFromJump(props)() || scopedQuestion.set(null)}
								onAnswered={() => {
									void props.day.scope?.read(todayProject());
								}}
							/>
						)}
					</If>
				</If>
			}
		>
			<Each of={searchDetail() ? [searchDetail() as DetailHit] : []} key={(hit) => hit.key}>
				{(hit) => <SearchDetailScreen places={props} source={props.day.search as WorkSearchSource} hit={hit()} />}
			</Each>
		</If>
	);
}

function MainScreens(props: { at: Shown; day: Day; rituals: Rituals; plans?: Plans; changes?: Changes }) {
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
								<FeedbackScreen day={props.day} onBackFromJump={backFromJump(props)} />
							</Arrive>
						</If>
					}
				>
					<Arrive class="flex-1">
						<SettingsScreen day={props.day} onBackFromJump={backFromJump(props)} />
					</Arrive>
				</If>
			}
		>
			<Each of={chatRoute() ? [chatRoute()?.sessionId as string] : []} key={(id) => id}>
				{(id) => (
					<Arrive class="flex-1">
						<ChatScreen day={props.day} sessionId={id()} onBackFromJump={backFromJump(props)} />
					</Arrive>
				)}
			</Each>
		</If>
	);
}

function Results(props: { at: Shown; day: Day; rituals: Rituals; plans?: Plans; changes?: Changes }) {
	return (
		<If
			when={props.at === "insights"}
			else={
				<If when={props.at === "slack"} else={<OtherResults {...props} />}>
					<Arrive class="flex-1">
						<SlackReportsScreen day={props.day} />
					</Arrive>
				</If>
			}
		>
			<Arrive class="flex-1">
				<InsightsScreen
					controls={props.day.insights!}
					onBack={backFromJump(props)}
					openChat={props.day.chat ? (id) => openChat(id, "Insights") : undefined}
					openWork={
						props.plans
							? {
									available: canDraftInsight,
									wouldReplace: hasOtherDraft,
									draft: openFindingDraft,
								}
							: undefined
					}
				/>
			</Arrive>
		</If>
	);
}

function OtherResults(props: { at: Shown; day: Day; rituals: Rituals; plans?: Plans; changes?: Changes }) {
	return (
		<If
			when={props.at === "delivery" || props.at === "code-review"}
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
								<ArtifactsScreen
									source={props.day.artifacts as ArtifactSource}
									onBackFromJump={backFromJump(props)}
								/>
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
						<DeliveryScreen day={props.day} place={p()} onBackFromJump={backFromJump(props)} />
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
												<MissionScreen
													day={props.day}
													plans={props.plans}
													missionId={id()}
													onBackFromJump={backFromJump(props)}
												/>
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
			<ChangesScreen changes={props.changes as Changes} onBackFromJump={backFromJump(props)} />
		</If>
	);
}
