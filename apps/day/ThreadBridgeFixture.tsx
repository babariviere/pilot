// Test-only: the real connected threads adapter and thread page over the injected native host channel. A
// day.changed for this window reads what is on screen again, as connection.ts does.
import { host, mount } from "nsh";
import { ScriptedDelivery } from "./deliveryDemo";
import { mirrorDelivery } from "./deliveryFeed";
import { MockDayScreen, openDay } from "./mockFeeds";
import { ConnectedThreads, mirrorThreads } from "./threadFeed";
import { refreshOpenThread } from "./threadView";

const day = {
	...openDay(),
	threads: mirrorThreads(new ConnectedThreads("fixture")),
	delivery: mirrorDelivery(new ScriptedDelivery()),
};
host.on("day.changed", (payload) => {
	if ((payload as { version?: unknown; window?: unknown } | null)?.window === "fixture")
		refreshOpenThread(day.threads);
});
mount(() => <MockDayScreen day={day} />);
