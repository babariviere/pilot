// Headless control fixture only. No daemon, worker, provider or storage.
// To check and one delivered result's page over the scripted source with
// the connected rules (deliveryDemo.ts): a command names the exact result
// and revision shown and is sent once; a lost answer stays Unknown until
// Check reads it; Check never sends again; a save and reopen keeps unsent
// notes and sends nothing. Inspect source reads one exact pin's saved
// source once and shows it as plain text; nothing runs it.
import { mount, Scroll, Text, View } from "nsh";
import { DeliveryScreen } from "./DeliveryScreen";
import { openDay } from "./day";
import { ScriptedDelivery } from "./deliveryDemo";
import { mirrorDelivery } from "./deliveryFeed";
import { type DeliveryPlace, deliveryRoute } from "./deliveryView";
import { ToCheck } from "./ToCheck";
import { Action } from "./ui";
import { captureView, restoreView, startFresh } from "./updateView";

const source = new ScriptedDelivery();
const day = { ...openDay(), delivery: mirrorDelivery(source) };

mount(() => (
	<View class="flex-1 bg-background">
		<View class="flex-1">
			<If
				when={deliveryRoute()}
				else={
					<Scroll class="flex-1">
						<View class="w-full max-w-2xl self-center gap-6 px-6 py-6">
							<ToCheck day={day} />
						</View>
					</Scroll>
				}
			>
				<Each of={deliveryRoute() ? [deliveryRoute() as DeliveryPlace] : []} key={(p) => p.key}>
					{(p) => <DeliveryScreen day={day} place={p()} />}
				</Each>
			</If>
		</View>
		<Scroll class="max-h-48 border-t border-border">
			<View class="gap-1 px-6 py-3">
				<Text testID="counts">{`Sends: ${source.counts().sends} · Checks: ${source.counts().checks}`}</Text>
				<Text testID="last-note">{`Note sent: [${source.counts().note}]`}</Text>
				<Text testID="opened">{`Opened: [${source.opened().join(" ")}]`}</Text>
				<Text testID="reads">{`Source reads: [${source.reads().join(" ")}]`}</Text>
				<View class="flex-row flex-wrap gap-1">
					<Action label="Lose next answer" onPress={() => (source.script.loseNext = true)} />
					<Action label="Lose next open" onPress={() => (source.script.loseOpen = true)} />
					<Action
						label="Move link"
						onPress={() =>
							source.moveLink("task/mock-project/native/native-4", "https://github.com/mock/pilot/pull/432")
						}
					/>
					<Action
						label="No browser"
						onPress={() => {
							source.webLinks = false;
							source.publish();
						}}
					/>
					<Action label="Hold answers" onPress={() => (source.script.hold = true)} />
					<Action label="Release answer" onPress={() => source.release()} />
					<Action label="Hold reads" onPress={() => (source.script.holdReads = true)} />
					<Action label="Release reads" onPress={() => source.releaseReads()} />
					<Action label="Leave mission" onPress={() => (source.script.refuseReads = "stale")} />
					<Action label="Close channel" onPress={() => (source.script.refuseReads = "closed")} />
					<Action
						label="Unsaved copies"
						onPress={() => {
							source.unavailable = {
								"3f0d6c2a-6b1e-4f7a-9d1c-2a5e8b7c4d10": "missing",
								"9a4e1f7b-2c3d-4e5f-8a6b-7c8d9e0f1a2b": "oversize",
							};
						}}
					/>
					<Action
						label="Held back"
						onPress={() => {
							source.unavailable = {
								"3f0d6c2a-6b1e-4f7a-9d1c-2a5e8b7c4d10": "redacted",
								"9a4e1f7b-2c3d-4e5f-8a6b-7c8d9e0f1a2b": "invalid",
							};
						}}
					/>
					<Action
						label="Lose service"
						onPress={() => {
							source.unreadable.add("task/mock-project/native/native-4");
							source.publish();
						}}
					/>
					<Action
						label="New result"
						onPress={() => source.deliverAgain("task/mock-project/native/native-4", "4")}
					/>
					<Action
						label="Save and reopen"
						onPress={() => {
							const v = captureView(day.today());
							startFresh();
							restoreView(v);
						}}
					/>
				</View>
			</View>
		</Scroll>
	</View>
));
