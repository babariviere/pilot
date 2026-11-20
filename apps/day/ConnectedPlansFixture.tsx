// Test-only: planning over the injected native host channel (bridge.ts). It
// opens one mission and shows where its interview submission is.
import { mount, signal } from "nsh";
import { ConnectedPlans } from "./missions/planning/planFeed";
import { Block, Body, Button } from "./ui";

const plans = new ConnectedPlans("fixture", null);
const submit = signal("");
plans.onChange(() => submit.set(plans.page("export")?.interview?.submit ?? "none"));
void plans.open("export");
mount(() => (
	<Block>
		<Body testID="submit">{`submit: ${submit()}`}</Body>
		<Button label="Read the list" onPress={() => void plans.readInventory()} />
	</Block>
));
