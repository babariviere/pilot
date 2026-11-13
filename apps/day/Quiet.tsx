// Nothing waits.
import { mount } from "nsh";
import { MockDayScreen, openDay } from "./mockFeeds";

const day = openDay("quiet");
mount(() => <MockDayScreen day={day} />);
