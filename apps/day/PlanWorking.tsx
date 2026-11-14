// A new mission whose planning agent is still writing its first questions:
// its step now, how long it has worked, and its chat, read only.
import { mount } from "nsh";
import { MockDayScreen, openDay, openPlanning } from "./mockFeeds";

const day = openDay("quiet");
const plans = openPlanning("working");
mount(() => <MockDayScreen day={day} plans={plans} />);
