// Nothing could be read and no earlier read exists: Today says so.
import { mount } from "nsh";
import { openDay } from "./day";
import { MockDayScreen } from "./mockFeeds";

const day = openDay("unreadable");
mount(() => <MockDayScreen day={day} />);
