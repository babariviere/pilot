// Pilot's service is not registered, and macOS refuses the first
// registration. The user allows it and registers again.
import { mount } from "nsh";
import { MockDayScreen, openDay, openUpdate } from "./mockFeeds";
import { showUpdate } from "./updateView";

const day = openDay("quiet");
const update = openUpdate("denied");
showUpdate();
mount(() => <MockDayScreen day={day} update={update} />);
