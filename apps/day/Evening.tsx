// A calm evening: nothing waits, results came in since the afternoon and
// two missions keep moving. Today offers the end of the day.
import { mount } from "nsh";
import { openDay } from "./day";
import { MockDayScreen } from "./mockFeeds";

const day = openDay("evening");
mount(() => <MockDayScreen day={day} />);
