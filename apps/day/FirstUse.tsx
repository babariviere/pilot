// The user's first look, in the morning: nothing to catch up on, nothing
// waiting and one mission with no report yet.
import { mount } from "nsh";
import { openDay } from "./day";
import { MockDayScreen } from "./mockFeeds";

const day = openDay("firstUse");
mount(() => <MockDayScreen day={day} />);
