// Pilot's service is registered but not answering: updates wait, and
// Check again only reads.
import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";
import { openUpdate } from "./updateFeed";
import { showUpdate } from "./updateView";

const day = openDay("offline");
const update = openUpdate("offline");
showUpdate();
mount(() => <DayScreen day={day} update={update} />);
