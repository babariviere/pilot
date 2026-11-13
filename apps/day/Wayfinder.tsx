// A Wayfinder map: questions for the user and research on the frontier,
// prototypes not available, fog of war, and an open topic interview.
import { mount } from "nsh";
import { openDay } from "./day";
import { MockDayScreen, openPlanning } from "./mockFeeds";

const day = openDay("quiet");
const plans = openPlanning("wayfinder");
mount(() => <MockDayScreen day={day} plans={plans} />);
