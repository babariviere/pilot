// The user's first look, in the morning: nothing to catch up on, nothing
// waiting and one mission with no report yet.
import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";

const day = openDay("firstUse");
mount(() => <DayScreen day={day} />);
