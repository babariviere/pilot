// Test-only: planning over the injected native host channel (bridge.ts). It
// opens one mission and shows where its interview submission is.
import { mount, signal, Text, View } from "nsh";
import { ConnectedPlans } from "./bridge";
import { Action } from "./ui";

const plans = new ConnectedPlans("fixture", null);
const submit = signal("");
plans.onChange(() => submit.set(plans.page("export")?.interview?.submit ?? "none"));
void plans.open("export");
mount(() => (
	<View>
		<Text testID="submit">{`submit: ${submit()}`}</Text>
		<Action label="Read the list" onPress={() => void plans.readInventory()} />
	</View>
));
