// Headless control fixture only. No daemon, worker, provider or storage.
// Needs you with nothing to decide: the scripted results to check (deliveryDemo.ts) queue as cards.
import { mount } from "nsh";
import { ScriptedDelivery } from "./deliveryDemo";
import { mirrorDelivery } from "./deliveryFeed";
import { MockDayScreen, openDay } from "./mockFeeds";

const day = { ...openDay("quiet"), delivery: mirrorDelivery(new ScriptedDelivery()) };
mount(() => <MockDayScreen day={day} />);
