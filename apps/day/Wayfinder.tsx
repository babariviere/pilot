// A Wayfinder map: questions for the user and research on the frontier,
// prototypes not available, fog of war, and an open topic interview.
import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";
import { openPlanning } from "./planning";

const day = openDay("quiet");
const plans = openPlanning("wayfinder");
mount(() => <DayScreen day={day} plans={plans} />);
