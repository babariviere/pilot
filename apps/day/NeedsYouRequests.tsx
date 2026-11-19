// Headless control fixture only. No daemon, worker, provider or storage.
// Needs you with nothing to decide, scripted results to check (deliveryDemo.ts)
// and scripted requests (intakeDemo.ts): the Slack request cards wait behind the results.
import { mount } from "nsh";
import { ScriptedDelivery } from "./deliveryDemo";
import { mirrorDelivery } from "./deliveryFeed";
import { scriptedIntake } from "./intakeDemo";
import { mirrorIntake } from "./intakeFeed";
import { MockDayScreen, openDay } from "./mockFeeds";

const day = {
	...openDay("quiet"),
	delivery: mirrorDelivery(new ScriptedDelivery()),
	intake: mirrorIntake(scriptedIntake),
};
void scriptedIntake.read();
mount(() => <MockDayScreen day={day} />);
