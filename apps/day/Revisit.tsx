// An older mission with a published plan, offered a Revisit: new questions
// for its gaps, then the exact revision to review and confirm.
import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";
import { openPlanning } from "./planning";

const day = openDay("quiet");
const plans = openPlanning("revisit");
mount(() => <DayScreen day={day} plans={plans} />);
