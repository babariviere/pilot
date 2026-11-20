// Pilot's service is registered but not answering: updates wait, and
// Check again only reads.
import { mount } from "nsh";
import { MockDayScreen, openDay, openUpdate } from "./app/testing/mockFeeds";
import { showUpdate } from "./updates/updateView";

const day = openDay("offline");
const update = openUpdate("offline");
showUpdate();
mount(() => <MockDayScreen day={day} update={update} />);
