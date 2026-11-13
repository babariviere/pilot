// One mission interview in progress: three of seven questions answered.
// Submitting it raises a dependent second round, then a plan to review.
import { mount } from "nsh";
import { MockDayScreen, openDay, openPlanning } from "./mockFeeds";

const day = openDay("quiet");
const plans = openPlanning("interview");
mount(() => <MockDayScreen day={day} plans={plans} />);
