// Test-only: threads, preferences and results over the injected native host
// channel, showing only where one lost write of each stands. The test
// scripts every root reply.
import { mount, signal, Text, View } from "nsh";
import { ConnectedDelivery } from "./deliveryFeed";
import { ConnectedPreferences } from "./preferencesFeed";
import { ConnectedThreads } from "./threadFeed";
import { Action } from "./ui";

const threads = new ConnectedThreads("fixture");
const preferences = new ConnectedPreferences("fixture");
const delivery = new ConnectedDelivery("fixture");
const thread = signal("none");
const preference = signal("none");
const result = signal("none");
threads.onChange((s) => thread.set(s.missions.m?.ops[0]?.state ?? "none"));
preferences.onChange((v) => preference.set(v.unsettled[0]?.state ?? "none"));
delivery.onChange((v) => {
	const op = v.unsettled[0];
	result.set(op ? (op.checking ? "checking" : "unknown") : "none");
});
const readAll = () => {
	void threads.read("m");
	void preferences.read();
	void delivery.readSaved();
};
readAll();
mount(() => (
	<View>
		<Text>{`thread: ${thread()}`}</Text>
		<Text>{`preference: ${preference()}`}</Text>
		<Text>{`result: ${result()}`}</Text>
		<Action label="Read again" onPress={readAll} />
	</View>
));
