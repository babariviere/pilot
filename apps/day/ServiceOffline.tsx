// Pilot's service is registered but not answering: updates wait, and
// Check again only reads.
import { mount } from "nsh";
import { MockDayScreen, openDay, openUpdate } from "./mockFeeds";
import { showUpdate } from "./updateView";

const day = openDay("offline");
const update = openUpdate("offline");
showUpdate();
mount(() => <MockDayScreen day={day} update={update} />);
