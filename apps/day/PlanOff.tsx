// Planning is not connected: New shows why and sends nothing.
import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";
import { openPlanning } from "./planning";

const day = openDay("quiet");
const plans = openPlanning("unavailable");
mount(() => <DayScreen day={day} plans={plans} />);
