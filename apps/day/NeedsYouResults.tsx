// Headless control fixture only. No daemon, worker, provider or storage.
// Needs you with nothing to decide: the scripted results to check (deliveryDemo.ts) queue as cards.
import { mount } from "nsh";
import { MockDayScreen, openDay } from "./app/testing/mockFeeds";
import { ScriptedDelivery } from "./missions/delivery/deliveryDemo";
import { mirrorDelivery } from "./missions/delivery/deliveryFeed";

const day = { ...openDay("quiet"), delivery: mirrorDelivery(new ScriptedDelivery()) };
mount(() => <MockDayScreen day={day} />);
