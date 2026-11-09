// A finished interview whose plan waits for the user's review: the full
// spec, testing, slices with their order and owners, and open fog.
import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";
import { openPlanning } from "./planning";

const day = openDay("quiet");
const plans = openPlanning("review");
mount(() => <DayScreen day={day} plans={plans} />);
