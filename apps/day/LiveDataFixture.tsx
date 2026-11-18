// Headless control fixture only. No daemon, worker, provider or storage.
// Today on a feed whose reads the test delivers (keys, so the focused field
// keeps the focus), and the window's automatic reads on a test clock.
import { keymap, mount, Scroll, signal, Text, View } from "nsh";
import { type Today, TodayFeed } from "pilot-day/native";
import { mirrorDay } from "./day";
import type { DayFeed } from "./feeds";
import { autoRead, type Clock, type ReadResult } from "./freshness";
import { MockDayScreen } from "./mockFeeds";
import { Action } from "./ui";
import { anchors } from "./view";

// The asks world: two questions that take the user's own words.
const real = new TodayFeed("asks");
let shown: Today = real.snapshot();
const listeners = new Set<(today: Today) => void>();
const deliver = (next: Today) => {
	shown = next;
	for (const listener of listeners) listener(next);
};
// The mock feed, except that its reads are the ones this fixture delivers.
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

// A test clock: time moves only when the test says.
let now = Date.UTC(2026, 10, 9, 10, 0);
let ids = 0;
const timers = new Map<number, { at: number; run: () => void }>();
const clock: Clock = {
	now: () => now,
	setTimeout: (run, ms) => {
		ids += 1;
		timers.set(ids, { at: now + ms, run });
		return ids;
	},
	clearTimeout: (id) => {
		timers.delete(id as number);
	},
};
const pass = (ms: number) => {
	now += ms;
	for (const [id, timer] of [...timers]) {
		if (timer.at > now) continue;
		timers.delete(id);
		timer.run();
	}
};
let answer: ReadResult = "failed";
const freshness = autoRead(async () => answer, now, clock);
const day = mirrorDay(feed, { freshness });

/** The same read again, as new objects: nothing on screen may change. */
const same = () => deliver(JSON.parse(JSON.stringify(shown)) as Today);
/** A read with unrelated changes: a new question arrives first, the summary changes, and the read is marked as changing. */
const unrelated = () => {
	const next = JSON.parse(JSON.stringify(shown)) as Today;
	const arrival = { ...next.decisions[1], id: "arrival", title: "A new question arrived" };
	next.decisions = [arrival, ...next.decisions];
	next.summary = "Something else changed.";
	next.revision += 1;
	next.freshness = { ...next.freshness, state: "stale", reason: "" };
	next.attention = {
		...next.attention,
		state: "stale",
		reason: "Reading changes. Showing the earlier attention read.",
	};
	deliver(next);
};
// Each card registers its focus anchor when it is built: the same function
// later means the same card, never built again.
let marked: unknown = null;
const card = signal("");
keymap.bind("mod+shift+1", same, { when: "always" });
keymap.bind("mod+shift+2", unrelated, { when: "always" });

mount(() => (
	<View class="flex-1 bg-background">
		<View class="flex-1">
			<MockDayScreen day={day} />
		</View>
		<Scroll class="max-h-40 border-t border-border">
			<View class="flex-row flex-wrap gap-1 px-6 py-3">
				<Action label="Mark card" onPress={() => (marked = anchors.get("ask1") ?? null)} />
				<Action
					label="Check card"
					onPress={() =>
						card.set(marked !== null && anchors.get("ask1") === marked ? "Card kept" : "Card built again")
					}
				/>
				<Text testID="card">{card()}</Text>
				<Action label="Same read" onPress={same} />
				<Action label="Unrelated read" onPress={unrelated} />
				<Action
					label="Automatic try"
					onPress={() => {
						void freshness.now();
					}}
				/>
				<Action label="Six minutes pass" onPress={() => pass(6 * 60_000)} />
				<Action
					label="Reads work"
					onPress={() => {
						answer = "current";
					}}
				/>
			</View>
		</Scroll>
	</View>
));
