// Test-only: the real connected threads adapter and thread page over the injected native host channel. A
// day.changed for this window reads what is on screen again, as connection.ts does.
import { host, mount, signal, View } from "nsh";
import { ScriptedDelivery } from "./deliveryDemo";
import { mirrorDelivery } from "./deliveryFeed";
import { scrollOf } from "./kept";
import { MockDayScreen, openDay } from "./mockFeeds";
import { readingProbe } from "./ThreadScreen";
import { ConnectedThreads, mirrorThreads } from "./threadFeed";
import { refreshOpenThread } from "./threadView";
import { Block, Button, Buttons, Caption } from "./ui";

const day = {
	...openDay(),
	threads: mirrorThreads(new ConnectedThreads("fixture")),
	delivery: mirrorDelivery(new ScriptedDelivery()),
};
host.on("day.changed", (payload) => {
	if ((payload as { version?: unknown; window?: unknown } | null)?.window === "fixture")
		refreshOpenThread(day.threads);
});
/** The thread page's kept scroll offset, as it last reported it. */
const where = signal("");
const anchor = signal("");
let probes = 0;
mount(() => (
	<View class="flex-1">
		<Block>
			<Buttons>
				<Button
					label="Where"
					onPress={() => {
						where.set(`Scroll: ${Math.round(scrollOf("thread/search/t1"))}`);
						const n = ++probes;
						void readingProbe().then((p) =>
							anchor.set(p ? `Anchor ${n}: ${p.key} ${Math.round(p.top)}` : `Anchor ${n}: none`),
						);
					}}
				/>
				<Caption testID="where">{where()}</Caption>
				<Caption testID="anchor">{anchor()}</Caption>
			</Buttons>
		</Block>
		<MockDayScreen day={day} />
	</View>
));
