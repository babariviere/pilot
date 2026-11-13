// A mission interview with 40 questions, the most one round holds.
import { mount } from "nsh";
import { openDay } from "./day";
import { MockDayScreen, openPlanning } from "./mockFeeds";

const day = openDay("quiet");
const plans = openPlanning("long");
mount(() => <MockDayScreen day={day} plans={plans} />);
