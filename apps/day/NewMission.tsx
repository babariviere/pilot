// No planning yet: New, a mission interview from the user's own goal, and
// a small ask that starts one chat directly.
import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";
import { openPlanning } from "./planning";

const day = openDay("quiet");
const plans = openPlanning("fresh");
mount(() => <DayScreen day={day} plans={plans} />);
