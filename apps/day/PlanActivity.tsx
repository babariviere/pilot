// What Pilot's planning agent does now, and its chat, read only. Activity,
// not progress: a step is not a result and a time is not an estimate.
// Reading the chat sends nothing; while it is open, Pilot reads it again as
// the agent works. The chat is the planning page's Activity tab.
import { cleanup, signal, View } from "nsh";
import type { PlanActivity, PlanPage } from "pilot-day/native";
import { activityQuiet, activityTime } from "./activityWords";
import { ChatTranscript } from "./ChatRows";
import type { Plans } from "./planning";
import { Block, Body, Caption, Mark, Notice, Section } from "./ui";

/** How often the times read again while the line shows. */
const CLOCK_MS = 15_000;

/** The agent's step now, how long, and a quiet warning. Its chat is the page's Activity tab. */
export function ActivityLine(props: { plans: Plans; page: PlanPage; activity: PlanActivity }) {
	// The status line only while it works or plans.
	const status = () => props.activity.working || props.page.stage === "planning";
	const now = signal(Date.now());
	const clock = setInterval(() => now.set(Date.now()), CLOCK_MS);
	cleanup(() => clearInterval(clock));
	const time = () => activityTime(props.activity, now());
	const quiet = () => activityQuiet(props.activity, now());
	return (
		<View testID="plan-activity">
			<If when={status()}>
				<Block>
					{/* LIBRARY GAP: Row cannot put a test ID on its title or meta, and tests read the step and its time by
					    their own IDs. This mark-and-words line uses layout classes only until Row offers them. */}
					<View class="flex-row items-start gap-2.5">
						<Mark kind={props.activity.working ? "working" : "new"} />
						<View class="min-w-0 flex-1 gap-0.5">
							<Body testID="plan-activity-step">
								{props.activity.working
									? props.activity.step || "Working"
									: "Pilot's planning agent is not working now."}
							</Body>
							<If when={time()}>
								<Caption testID="plan-activity-time" tone="faint">
									{time()}
								</Caption>
							</If>
						</View>
					</View>
				</Block>
			</If>
			<If when={quiet()}>
				<Notice testID="plan-activity-quiet" kind="needs" role="alert" placement="section" text={quiet()} />
			</If>
		</View>
	);
}

/** The agent's chat while it shows: read on open, closed when it goes. */
export function PlanChat(props: { plans: Plans; missionId: string }) {
	const feed = props.plans.feed;
	const id = props.missionId;
	void feed.readChat?.(id, false);
	cleanup(() => feed.closeChat?.());
	const chat = () => {
		props.plans.planning();
		return feed.chat?.(id) ?? null;
	};
	return (
		<Section testID="plan-chat" title="Planning chat">
			<Block gap={3}>
				<Caption>Read only. Reading it sends nothing and changes nothing.</Caption>
				<ChatTranscript
					id="plan-chat"
					chat={chat()}
					readingWords="Reading the planning chat…"
					emptyWords="The planning agent has no messages yet."
					onEarlier={() => void feed.readChat?.(id, true)}
					read={() => feed.readChat?.(id, false) ?? Promise.resolve()}
				/>
			</Block>
		</Section>
	);
}
