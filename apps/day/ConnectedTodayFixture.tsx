// Test-only: Today over the injected native host channel (bridge.ts), with
// the trouble world's first read. The test scripts every root reply.
import { host, mount, View } from "nsh";
import { TodayFeed } from "pilot-day/native";
import { ConnectedToday } from "./bridge";
import { mirrorDay } from "./day";
import { MockDayScreen } from "./mockFeeds";
import { Block, Button, WindowCanvas } from "./ui";

const first = new TodayFeed("trouble").snapshot();
// `lost`: the first decision's answer was sent and its reply lost (Unknown).
const lost = (host.params as { lost?: boolean } | undefined)?.lost === true;
const today = {
	...first,
	decisions: first.decisions.map((d, n) => (n === 0 && lost ? { ...d, delivery: "unknown" as const } : d)),
};
const feed = new ConnectedToday("fixture", today);
const day = mirrorDay(feed);
mount(() => (
	<WindowCanvas>
		<Block>
			<Button label="Read Today" onPress={() => void feed.refresh()} />
		</Block>
		<View class="min-h-0 flex-1">
			<MockDayScreen day={day} />
		</View>
	</WindowCanvas>
));
