// One agent question shaped like a native card: it takes the user's own
// words, and Pilot has no help to offer for it.
import { mount } from "nsh";
import { openDay } from "./day";
import { MockDayScreen } from "./mockFeeds";

const day = openDay("asks");
mount(() => <MockDayScreen day={day} />);
