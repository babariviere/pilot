// The actions world: one decision and a Chrome Web Store upload only the
// user can do. The agent replaces the zip before the first report lands,
// and the answer to the next report is lost until a check reads it.
import { mount } from "nsh";
import { openDay } from "./day";
import { MockDayScreen } from "./mockFeeds";

const day = openDay("actions");
mount(() => <MockDayScreen day={day} />);
