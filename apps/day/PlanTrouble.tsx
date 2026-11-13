// Planning trouble: changed questions and a lost submission, a topic
// interview whose map changed, and a plan that changes during review.
import { mount } from "nsh";
import { MockDayScreen, openDay, openPlanning } from "./mockFeeds";

const day = openDay("quiet");
const plans = openPlanning("trouble");
mount(() => <MockDayScreen day={day} plans={plans} />);
