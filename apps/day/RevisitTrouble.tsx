// Revisits in trouble: a mission that changes while the user confirms, one
// whose chats still work, and a confirmation whose answer is lost.
import { mount } from "nsh";
import { MockDayScreen, openDay, openPlanning } from "./mockFeeds";

const day = openDay("quiet");
const plans = openPlanning("revisitTrouble");
mount(() => <MockDayScreen day={day} plans={plans} />);
