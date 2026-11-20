// Nothing waits.
import { mount } from "nsh";
import { MockDayScreen, openDay } from "./app/testing/mockFeeds";

const day = openDay("quiet");
mount(() => <MockDayScreen day={day} />);
