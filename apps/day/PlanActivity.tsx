// What Pilot's planning agent does now, and its chat, read only. Activity,
// not progress: a step is not a result and a time is not an estimate.
// Reading the chat sends nothing; while it is open, Pilot reads it again as
// the agent works.
import { cleanup, signal, Text, View } from "nsh";
import type { ChatRow, PlanActivity, PlanPage } from "pilot-day/native";
import { activityQuiet, activityTime } from "./activityWords";
import type { Plans } from "./planning";
import { chatOpen, put } from "./planView";
import { Action, Mark, SectionTitle } from "./ui";

/** How often the times read again while the line shows. */
const CLOCK_MS = 15_000;

/** The agent's step now, how long, a quiet warning, and the way into its chat. */
export function ActivityLine(props: { plans: Plans; page: PlanPage; activity: PlanActivity }) {
	const id = () => props.page.missionId;
	const open = () => chatOpen()[id()] === true;
	// The status line only while it works or plans; otherwise only the chat link.
	const status = () => props.activity.working || props.page.stage === "planning";
	const now = signal(Date.now());
	const clock = setInterval(() => now.set(Date.now()), CLOCK_MS);
	cleanup(() => clearInterval(clock));
	const time = () => activityTime(props.activity, now());
	const quiet = () => activityQuiet(props.activity, now());
	return (
		<View testID="plan-activity" class="gap-3">
			<If when={status()}>
				<View class="flex-row items-start gap-2.5">
					<View class="pt-1.5">
						<Mark kind={props.activity.working ? "moving" : "still"} />
					</View>
					<View class="flex-1 gap-0.5">
						<Text testID="plan-activity-step" class="text-sm text-foreground">
							{props.activity.working
								? props.activity.step || "Working"
								: "Pilot's planning agent is not working now."}
						</Text>
						<If when={time()}>
							<Text testID="plan-activity-time" class="text-xs text-faint">
								{time()}
							</Text>
						</If>
					</View>
				</View>
			</If>
			<If when={quiet()}>
				<View class="flex-row items-start gap-2.5 rounded-xl bg-muted px-4 py-3">
					<View class="pt-1.5">
						<Mark kind="needs" />
					</View>
					<Text testID="plan-activity-quiet" role="alert" class="flex-1 text-sm text-foreground">
						{quiet()}
					</Text>
				</View>
			</If>
			<If when={props.plans.feed.readChat}>
				<View class="-ml-3 flex-row">
					<Action
						label={open() ? "Hide planning chat" : "Show planning chat"}
						testID="plan-chat-toggle"
						accessibilityLabel={
							open()
								? "Hide the planning chat."
								: "Show the planning agent's chat, read only. This sends nothing."
						}
						onPress={() => put(chatOpen, id(), !open())}
					/>
				</View>
			</If>
			<If when={open() && props.plans.feed.readChat}>
				<PlanChatView plans={props.plans} missionId={id()} />
			</If>
		</View>
	);
}

/** The agent's chat while it shows: read on open, closed when it goes. */
function PlanChatView(props: { plans: Plans; missionId: string }) {
	const feed = props.plans.feed;
	const id = props.missionId;
	void feed.readChat?.(id, false);
	cleanup(() => feed.closeChat?.());
	const chat = () => {
		props.plans.planning();
		return feed.chat?.(id) ?? null;
	};
	return (
		<View testID="plan-chat" class="gap-3 border-l-2 border-border pl-4">
			<View class="gap-1">
				<SectionTitle title="Planning chat" />
				<Text class="text-xs text-muted-foreground">Read only. Reading it sends nothing and changes nothing.</Text>
			</View>
			<If when={chat()?.more}>
				<View class="flex-row">
					<Action
						label={chat()?.reading ? "Reading…" : "Show earlier"}
						testID="plan-chat-earlier"
						disabled={chat()?.reading === true}
						onPress={() => void feed.readChat?.(id, true)}
					/>
				</View>
			</If>
			<If when={chat()?.reason}>
				<View class="flex-row items-start gap-2.5">
					<View class="pt-1.5">
						<Mark kind="unknown" />
					</View>
					<Text testID="plan-chat-off" class="flex-1 text-sm text-muted-foreground">
						{chat()?.reason ?? ""}
					</Text>
				</View>
			</If>
			<If when={!chat() || (chat()?.reading && chat()?.rows.length === 0)}>
				<Text class="text-sm text-muted-foreground">Reading the planning chat…</Text>
			</If>
			<If when={chat() && !chat()?.reading && !chat()?.reason && chat()?.rows.length === 0}>
				<Text class="text-sm text-muted-foreground">The planning agent has no messages yet.</Text>
			</If>
			<Each of={chat()?.rows ?? []} key={(r) => r.key}>
				{(r) => <ChatLine row={r()} />}
			</Each>
		</View>
	);
}

function ChatLine(props: { row: ChatRow }) {
	return (
		<View testID={`plan-chat-${props.row.key}`}>
			<If when={props.row.role === "you"}>
				<View selectable class="self-end rounded-xl bg-muted px-3 py-2">
					<Text class="text-sm leading-relaxed text-foreground">{props.row.text}</Text>
				</View>
			</If>
			<If when={props.row.role === "pilot"}>
				<View selectable>
					<Text class="text-sm leading-relaxed text-foreground">{props.row.text}</Text>
				</View>
			</If>
			<If when={props.row.role === "request"}>
				<Text class="text-xs text-faint">{props.row.text}</Text>
			</If>
			<If when={props.row.role === "step"}>
				<View class="flex-row items-center gap-2">
					<If when={props.row.running || props.row.failed}>
						<Mark kind={props.row.failed ? "failed" : "moving"} />
					</If>
					<Text class="text-xs text-muted-foreground">
						{props.row.failed ? `${props.row.text} · Failed` : props.row.text}
					</Text>
				</View>
			</If>
			<If when={props.row.shortened}>
				<Text class="text-xs text-faint">Pilot shows the start of this long message only.</Text>
			</If>
		</View>
	);
}
