// Pilot's service is newer than this app: an app-only update fixes it and
// leaves every agent working.
import { mount } from "nsh";
import { openDay } from "./day";
import { MockDayScreen } from "./mockFeeds";
import { openUpdate } from "./updateFeed";
import { showUpdate } from "./updateView";

const day = openDay("quiet");
const update = openUpdate("newer");
showUpdate();
mount(() => <MockDayScreen day={day} update={update} />);
