// Revisits in trouble: a mission that changes while the user confirms, one
// whose chats still work, and a confirmation whose answer is lost.
import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";
import { openPlanning } from "./planning";

const day = openDay("quiet");
const plans = openPlanning("revisitTrouble");
mount(() => <DayScreen day={day} plans={plans} />);
