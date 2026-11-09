// A mission interview whose submission is kept but cannot be continued
// here yet: every later step says so.
import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";
import { openPlanning } from "./planning";

const day = openDay("quiet");
const plans = openPlanning("held");
mount(() => <DayScreen day={day} plans={plans} />);
