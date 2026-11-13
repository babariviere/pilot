// Headless control fixture only. No daemon, worker, provider or storage.
// Today with a scripted project scope (scopeDemo.ts): this window's own
// project (pilot) from the decisions world, website read only, and billing
// unreadable until the script says otherwise. Save and reopen restores only
// the window's screen state, as an update or a close would.
import { mount, Scroll, Text, View } from "nsh";
import { TodayFeed } from "pilot-day/native";
import { DayScreen } from "./DayScreen";
import { mirrorDay } from "./day";
import { openPlanning } from "./planning";
import { ScriptedScope } from "./scopeDemo";
import { mirrorScope } from "./todayScope";
import { Action } from "./ui";
import { captureView, restoreView, startFresh } from "./updateView";

const feed = new TodayFeed("decisions");
const scope = new ScriptedScope(() => feed.snapshot());
const day = mirrorDay(feed, undefined, undefined, undefined, mirrorScope(scope));
const plans = openPlanning();

mount(() => (
	<View class="flex-1 bg-background">
		<View class="flex-1">
			<DayScreen day={day} plans={plans} />
		</View>
		<Scroll class="max-h-40 border-t border-border">
			<View class="gap-1 px-6 py-3">
				<Text testID="reads">{`Reads: ${scope.reads()} · Sent: ${day.today().notes.length}`}</Text>
				<View class="flex-row flex-wrap gap-1">
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
