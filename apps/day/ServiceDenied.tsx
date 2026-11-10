// Pilot's service is not registered, and macOS refuses the first
// registration. The user allows it and registers again.
import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";
import { openUpdate } from "./updateFeed";
import { showUpdate } from "./updateView";

const day = openDay("quiet");
const update = openUpdate("denied");
showUpdate();
mount(() => <DayScreen day={day} update={update} />);
