// Headless control fixture only. No daemon, worker, provider or storage.
// Today with a scripted project scope, where Today's own read names its
// project as the native root's does. Switching projects must never show the
// previous project's read, even when its answer comes late.
import { mount, Scroll, View } from "nsh";
import { PlanFeed, type Today, TodayFeed } from "pilot-day/native";
import { mirrorDay } from "./app/day";
import { MockDayScreen } from "./app/testing/mockFeeds";
import { mirrorPlanning } from "./missions/planning/planning";
import { ScriptedChats } from "./sessions/chatDemo";
import { mirrorChats } from "./sessions/chatFeed";
import type { DayFeed } from "./sources/feeds";
import { todayScope } from "./today/ScopeRows";
import { ScriptedScope } from "./today/scopeDemo";
import { mirrorScope } from "./today/todayScope";
import { Block, Button, Buttons, Caption, WindowCanvas } from "./ui";

// Today's own read: pilot's, from the decisions world.
const real = new TodayFeed("decisions");
let shown: Today = { ...real.snapshot(), project: "demo-pilot" };
const listeners = new Set<(today: Today) => void>();
const deliver = (next: Today) => {
	shown = next;
	for (const listener of listeners) listener(next);
};
const feed = new Proxy(real, {
	get(target, key) {
		if (key === "snapshot") return () => shown;
		if (key === "onChange")
			return (listener: (today: Today) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			};
		const value = Reflect.get(target, key);
		return typeof value === "function" ? value.bind(target) : value;
	},
}) as unknown as DayFeed;
/** A global window's root: choosing one project makes it the one the window acts on. */
class GlobalScope extends ScriptedScope {
	override read(scope: string, generation: number, selectedOnly?: boolean) {
		if (scope !== "all") this.script.own = scope;
		return super.read(scope, generation, selectedOnly);
	}
}
const scope = new GlobalScope(() => shown);
scope.script.own = "demo-pilot";
const day = mirrorDay(feed, { scope: mirrorScope(scope) });
const plans = mirrorPlanning(new PlanFeed(), mirrorChats(new ScriptedChats()));
// The root moved the window to website: Today's own read is website's now.
const website = new TodayFeed("actions");
const toWebsite = () => deliver({ ...website.snapshot(), project: "demo-website" });

/** What Today counts as other projects, beside the chosen scope. */
function Others() {
	const ctx = todayScope(day, plans);
	return (
		<Caption testID="others">{`Others: [${ctx
			.others()
			.map((p) => p.id)
			.join(",")}] in ${ctx.scope()}`}</Caption>
	);
}

mount(() => (
	<WindowCanvas>
		<View class="flex-1">
			<MockDayScreen day={day} plans={plans} />
		</View>
		<Scroll class="max-h-40">
			<Block>
				<Buttons>
					<Button small label="Hold reads" onPress={() => (scope.script.hold = true)} />
					<Button small label="Release older read" onPress={() => scope.release(false)} />
					<Button
						small
						label="Release newer read"
						onPress={() => {
							scope.script.hold = false;
							scope.release(true);
						}}
					/>
					<Button small label="Reads time out" onPress={() => (scope.script.refusal = "offline")} />
					<Button small label="Today moves to website" onPress={toWebsite} />
					<Others />
				</Buttons>
			</Block>
		</Scroll>
	</WindowCanvas>
));
