// No planning yet: New, a mission interview from the user's own goal, and
// a small ask that starts one chat directly.
import { mount } from "nsh";
import { MockDayScreen, openDay, openPlanning } from "./mockFeeds";

const day = openDay("quiet");
const plans = openPlanning("fresh");
mount(() => <MockDayScreen day={day} plans={plans} />);
