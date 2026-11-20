// Test-only: Today over the injected native host channel (bridge.ts), with
// the trouble world's first read. The test scripts every root reply.
import { host, type JSX, mount, View } from "nsh";
import { TodayFeed } from "pilot-day/native";
import { ConnectedToday } from "./bridge";
import { mirrorDay } from "./day";
import { MockDayScreen } from "./mockFeeds";
import { Block, Button, GridBackdrop } from "./ui";

const first = new TodayFeed("trouble").snapshot();
// `lost`: the first decision's answer was sent and its reply lost (Unknown).
const lost = (host.params as { lost?: boolean } | undefined)?.lost === true;
const today = {
	...first,
	decisions: first.decisions.map((d, n) => (n === 0 && lost ? { ...d, delivery: "unknown" as const } : d)),
};
const feed = new ConnectedToday("fixture", today);
const day = mirrorDay(feed);
// LIBRARY GAP: no part paints a window's canvas (the background colour and GridBackdrop) for a fixture that mounts
// a screen or a control without DayScreen. This local root does what DayScreen's root does.
function FixtureWindow(props: { children?: JSX.Element }) {
	return (
		<View class="flex-1 bg-background">
			<GridBackdrop />
			{props.children}
		</View>
	);
}

mount(() => (
	<FixtureWindow>
		<Block>
			<Button label="Read Today" onPress={() => void feed.refresh()} />
		</Block>
		<View class="min-h-0 flex-1">
			<MockDayScreen day={day} />
		</View>
	</FixtureWindow>
));
