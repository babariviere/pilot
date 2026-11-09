// One mission interview in progress: three of seven questions answered.
// Submitting it raises a dependent second round, then a plan to review.
import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";
import { openPlanning } from "./planning";

const day = openDay("quiet");
const plans = openPlanning("interview");
mount(() => <DayScreen day={day} plans={plans} />);
