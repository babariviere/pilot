// A service update that stops before replacing anything: first a failed
// save, then a job whose processes cannot be shown to have ended.
import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";
import { openUpdate } from "./updateFeed";
import { showUpdate } from "./updateView";

const day = openDay("quiet");
const update = openUpdate("refused");
showUpdate();
mount(() => <DayScreen day={day} update={update} />);
