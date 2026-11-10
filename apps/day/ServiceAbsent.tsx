// Pilot's service is not registered. Registering is explicit; its answer
// is lost, and only Check again reads that it registered.
import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";
import { openUpdate } from "./updateFeed";
import { showUpdate } from "./updateView";

const day = openDay("quiet");
const update = openUpdate("absent");
showUpdate();
mount(() => <DayScreen day={day} update={update} />);
