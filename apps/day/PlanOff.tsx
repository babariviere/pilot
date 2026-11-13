// Planning is not connected: New shows why and sends nothing.
import { mount } from "nsh";
import { openDay } from "./day";
import { MockDayScreen, openPlanning } from "./mockFeeds";

const day = openDay("quiet");
const plans = openPlanning("unavailable");
mount(() => <MockDayScreen day={day} plans={plans} />);
