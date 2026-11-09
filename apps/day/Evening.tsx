// A calm evening: nothing waits, results came in since the afternoon and
// two missions keep moving. Today offers the end of the day.
import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";

const day = openDay("evening");
mount(() => <DayScreen day={day} />);
