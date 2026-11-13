// Nothing waits.
import { mount } from "nsh";
import { openDay } from "./day";
import { MockDayScreen } from "./mockFeeds";

const day = openDay("quiet");
mount(() => <MockDayScreen day={day} />);
