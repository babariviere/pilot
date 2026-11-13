// An older mission with a published plan, offered a Revisit: new questions
// for its gaps, then the exact revision to review and confirm.
import { mount } from "nsh";
import { openDay } from "./day";
import { MockDayScreen, openPlanning } from "./mockFeeds";

const day = openDay("quiet");
const plans = openPlanning("revisit");
mount(() => <MockDayScreen day={day} plans={plans} />);
