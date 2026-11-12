// Headless control fixture only. No daemon, worker, provider or storage.
// To check and one delivered result's page over the scripted source with
// the connected rules (deliveryDemo.ts): a command names the exact result
// and revision shown and is sent once; a lost answer stays Unknown until
// Check reads it; Check never sends again; a save and reopen keeps unsent
// notes and sends nothing.
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
				<View class="flex-row flex-wrap gap-1">
					<Action label="Lose next answer" onPress={() => (source.script.loseNext = true)} />
					<Action label="Hold answers" onPress={() => (source.script.hold = true)} />
					<Action label="Release answer" onPress={() => source.release()} />
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
