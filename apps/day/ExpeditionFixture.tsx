// Test fixture: the mock mission "Pilot on Linux desktops", opened at its
// Wayfinder chart. Every record is invented mock data.
import { mount } from "nsh";
import { restoreScroll } from "./kept";
import { MockDayScreen, openDay, openPlanning } from "./mockFeeds";
import { openPlan } from "./planView";

const day = openDay("quiet");
const plans = openPlanning("wayfinder");
// Start scrolled down to the chart, below the open interview.
restoreScroll("plan/linux", 760);
openPlan("linux");
mount(() => <MockDayScreen day={day} plans={plans} />);
