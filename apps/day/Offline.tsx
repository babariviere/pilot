// The decisions world, but Pilot's service stopped answering 6 minutes ago:
// the last read stays visible, and Pause and Resume wait for a fresh one.
import { mount } from "nsh";
import { MockDayScreen, openDay } from "./mockFeeds";

const day = openDay("offline");
mount(() => <MockDayScreen day={day} />);
