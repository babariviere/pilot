// One agent question shaped like a native card: it takes the user's own
// words, and Pilot has no help to offer for it.
import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";

const day = openDay("asks");
mount(() => <DayScreen day={day} />);
