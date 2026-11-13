// A service update that stops before replacing anything: first a failed
// save, then a job whose processes cannot be shown to have ended.
import { mount } from "nsh";
import { MockDayScreen, openDay, openUpdate } from "./mockFeeds";
import { showUpdate } from "./updateView";

const day = openDay("quiet");
const update = openUpdate("refused");
showUpdate();
mount(() => <MockDayScreen day={day} update={update} />);
