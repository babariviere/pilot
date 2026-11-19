// Headless control fixture only. No daemon, worker, provider or storage.
// Needs you with questions waiting: the scripted results to check queue behind them.
import { mount } from "nsh";
import { ScriptedDelivery } from "./deliveryDemo";
import { mirrorDelivery } from "./deliveryFeed";
import { MockDayScreen, openDay } from "./mockFeeds";

const day = { ...openDay(), delivery: mirrorDelivery(new ScriptedDelivery()) };
mount(() => <MockDayScreen day={day} />);
