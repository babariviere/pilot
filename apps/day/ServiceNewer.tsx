// Pilot's service is newer than this app: an app-only update fixes it and
// leaves every agent working.
import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";
import { openUpdate } from "./updateFeed";
import { showUpdate } from "./updateView";

const day = openDay("quiet");
const update = openUpdate("newer");
showUpdate();
mount(() => <DayScreen day={day} update={update} />);
