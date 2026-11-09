// The trouble world: a failure whose confirmation is lost, an unconfirmed
// push, a paused mission with an old report, and Pauses whose answer is lost
// (Release notes) or that do not finish everywhere (Native desktop app).
import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";

const day = openDay("trouble");
mount(() => <DayScreen day={day} />);
