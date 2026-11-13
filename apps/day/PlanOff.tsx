// Planning is not connected: New shows why and sends nothing.
import { mount } from "nsh";
import { MockDayScreen, openDay, openPlanning } from "./mockFeeds";

const day = openDay("quiet");
const plans = openPlanning("unavailable");
mount(() => <MockDayScreen day={day} plans={plans} />);
