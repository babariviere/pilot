// The decisions world with 200 more missions and 120 more results.
import { mount } from "nsh";
import { openDay } from "./day";
import { MockDayScreen } from "./mockFeeds";

const day = openDay("large");
mount(() => <MockDayScreen day={day} />);
