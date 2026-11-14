// Headless control fixture only. No daemon, worker, provider or storage.
// Today with a scripted project scope (scopeDemo.ts): this window's own
// project (pilot) from the decisions world, website with its rows, and billing
// unreadable until the script says otherwise. Save and reopen restores only
// the window's screen state, as an update or a close would.
import { effect, mount, Scroll, signal, Text, untracked, View } from "nsh";
import { PlanFeed, TodayFeed } from "pilot-day/native";
import { ScriptedChats } from "./chatDemo";
import { mirrorChats } from "./chatFeed";
import { mirrorDay } from "./day";
import { MockDayScreen } from "./mockFeeds";
import { mirrorPlanning } from "./planning";
import { ScriptedScope } from "./scopeDemo";
import { mirrorScope, todayProject } from "./todayScope";
import { Action } from "./ui";
import { captureView, restoreView, startFresh } from "./updateView";

const feed = new TodayFeed("decisions");
const scope = new ScriptedScope(() => feed.snapshot());
const day = mirrorDay(feed, undefined, undefined, undefined, mirrorScope(scope));
const chats = new ScriptedChats();
const plans = mirrorPlanning(new PlanFeed(), mirrorChats(chats));
// How often the scope view changed: an unchanged read must not change it.
const views = signal(0);
effect(() => {
	day.scope?.view();
	untracked(() => views.set(views() + 1));
});
const readAgain = () => void day.scope?.read(todayProject());

mount(() => (
	<View class="flex-1 bg-background">
		<View class="flex-1">
			<MockDayScreen day={day} plans={plans} />
		</View>
		<Scroll class="max-h-40 border-t border-border">
			<View class="gap-1 px-6 py-3">
				<Text testID="reads">{`Reads: ${scope.reads()} · Sent: ${day.today().notes.length}`}</Text>
				<Text testID="views">{`Scope views: ${views()}`}</Text>
				<View class="flex-row flex-wrap gap-1">
					<Action
						label="Global window"
						onPress={() => {
							chats.current = null;
							chats.publish();
						}}
					/>
					<Action label="Scope unavailable" onPress={() => (scope.script.unavailable = true)} />
					<Action label="Hold reads" onPress={() => (scope.script.hold = true)} />
					<Action
						label="Release newer read"
						onPress={() => {
							scope.script.hold = false;
							scope.release(true);
						}}
					/>
					<Action label="Release older read" onPress={() => scope.release(false)} />
					<Action label="Billing readable" onPress={() => (scope.script.billingReadable = true)} />
					<Action
						label="Focus website"
						onPress={() => {
							scope.script.own = "demo-website";
							readAgain();
						}}
					/>
					<Action label="Read scope again" onPress={readAgain} />
					<Action
						label="Changed meanwhile"
						onPress={() => {
							scope.script.refusal = "stale";
							readAgain();
						}}
					/>
					<Action
						label="Save and reopen"
						onPress={() => {
							const view = captureView(day.today());
							startFresh();
							restoreView(view);
						}}
					/>
				</View>
			</View>
		</Scroll>
	</View>
));
