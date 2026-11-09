// Planning trouble: changed questions and a lost submission, a topic
// interview whose map changed, and a plan that changes during review.
import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";
import { openPlanning } from "./planning";

const day = openDay("quiet");
const plans = openPlanning("trouble");
mount(() => <DayScreen day={day} plans={plans} />);
