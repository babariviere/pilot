// A mission interview whose submission is kept but cannot be continued
// here yet: every later step says so.
import { mount } from "nsh";
import { MockDayScreen, openDay, openPlanning } from "./app/testing/mockFeeds";

const day = openDay("quiet");
const plans = openPlanning("held");
mount(() => <MockDayScreen day={day} plans={plans} />);
