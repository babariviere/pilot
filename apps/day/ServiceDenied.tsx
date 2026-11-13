// Pilot's service is not registered, and macOS refuses the first
// registration. The user allows it and registers again.
import { mount } from "nsh";
import { openDay } from "./day";
import { MockDayScreen } from "./mockFeeds";
import { openUpdate } from "./updateFeed";
import { showUpdate } from "./updateView";

const day = openDay("quiet");
const update = openUpdate("denied");
showUpdate();
mount(() => <MockDayScreen day={day} update={update} />);
