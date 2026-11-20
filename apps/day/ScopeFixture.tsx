// Headless control fixture only. No daemon, worker, provider or storage.
// Today with a scripted project scope (scopeDemo.ts): this window's own
// project (pilot) from the decisions world, website with its rows, and billing
// unreadable until the script says otherwise. Save and reopen restores only
// the window's screen state, as an update or a close would.
import { effect, mount, Scroll, signal, untracked, View } from "nsh";
import { PlanFeed, TodayFeed } from "pilot-day/native";
import { mirrorDay } from "./app/day";
import { MockDayScreen } from "./app/testing/mockFeeds";
import { captureView, restoreView, startFresh } from "./app/windowState";
import { mirrorPlanning } from "./missions/planning/planning";
import { ScriptedChats } from "./sessions/chatDemo";
import { mirrorChats } from "./sessions/chatFeed";
import { ScriptedScope } from "./today/scopeDemo";
import { mirrorScope, todayProject } from "./today/todayScope";
import { Block, Button, Buttons, Caption, WindowCanvas } from "./ui";

const feed = new TodayFeed("decisions");
const scope = new ScriptedScope(() => feed.snapshot());
const day = mirrorDay(feed, { scope: mirrorScope(scope) });
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
	<WindowCanvas>
		<View class="flex-1">
			<MockDayScreen day={day} plans={plans} />
		</View>
		<Scroll class="max-h-40">
			<Block gap={1}>
				<Caption testID="reads">{`Reads: ${scope.reads()} · Sent: ${day.today().notes.length}`}</Caption>
				<Caption testID="views">{`Scope views: ${views()}`}</Caption>
				<Buttons>
					<Button
						small
						label="Global window"
						onPress={() => {
							chats.current = null;
							chats.publish();
						}}
					/>
					<Button small label="Scope unavailable" onPress={() => (scope.script.unavailable = true)} />
					<Button small label="Hold reads" onPress={() => (scope.script.hold = true)} />
					<Button
						small
						label="Release newer read"
						onPress={() => {
							scope.script.hold = false;
							scope.release(true);
						}}
					/>
					<Button small label="Release older read" onPress={() => scope.release(false)} />
					<Button small label="Billing readable" onPress={() => (scope.script.billingReadable = true)} />
					<Button
						small
						label="Empty billing"
						onPress={() => {
							scope.script.billingReadable = true;
							scope.script.emptyBilling = true;
							readAgain();
						}}
					/>
					<Button
						small
						label="Website requests only"
						onPress={() => {
							scope.script.requestsOnly = true;
							readAgain();
						}}
					/>
					<Button
						small
						label="Two stopped website chats"
						onPress={() => {
							scope.script.requestsOnly = true;
							scope.script.stoppedWebsite = true;
							readAgain();
						}}
					/>
					<Button
						small
						label="Focus website"
						onPress={() => {
							scope.script.own = "demo-website";
							readAgain();
						}}
					/>
					<Button small label="Read scope again" onPress={readAgain} />
					<Button
						small
						label="Changed meanwhile"
						onPress={() => {
							scope.script.refusal = "stale";
							readAgain();
						}}
					/>
					<Button
						small
						label="Save and reopen"
						onPress={() => {
							const view = captureView(day.today());
							startFresh();
							restoreView(view);
						}}
					/>
				</Buttons>
			</Block>
		</Scroll>
	</WindowCanvas>
));
