// Headless control fixture only. No daemon, worker, provider or storage.
// Needs you with questions waiting: the scripted results to check queue behind them.
import { mount } from "nsh";
import { MockDayScreen, openDay } from "./app/testing/mockFeeds";
import { ScriptedDelivery } from "./missions/delivery/deliveryDemo";
import { mirrorDelivery } from "./missions/delivery/deliveryFeed";

const day = { ...openDay(), delivery: mirrorDelivery(new ScriptedDelivery()) };
mount(() => <MockDayScreen day={day} />);
