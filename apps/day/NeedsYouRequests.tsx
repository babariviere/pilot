// Headless control fixture only. No daemon, worker, provider or storage.
// Needs you with nothing to decide, scripted results to check (deliveryDemo.ts)
// and scripted requests (intakeDemo.ts): the Slack request cards wait behind the results.
import { mount } from "nsh";
import { MockDayScreen, openDay } from "./app/testing/mockFeeds";
import { ScriptedDelivery } from "./missions/delivery/deliveryDemo";
import { mirrorDelivery } from "./missions/delivery/deliveryFeed";
import { scriptedIntake } from "./missions/intake/intakeDemo";
import { mirrorIntake } from "./missions/intake/intakeFeed";

const day = {
	...openDay("quiet"),
	delivery: mirrorDelivery(new ScriptedDelivery()),
	intake: mirrorIntake(scriptedIntake),
};
void scriptedIntake.read();
mount(() => <MockDayScreen day={day} />);
