// A mission interview with 40 questions, the most one round holds.
import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";
import { openPlanning } from "./planning";

const day = openDay("quiet");
const plans = openPlanning("long");
mount(() => <DayScreen day={day} plans={plans} />);
