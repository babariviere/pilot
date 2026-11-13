// A service update whose first confirmation is stale (a newer update
// arrived) and whose next answer is lost: it stays unconfirmed until Check
// again reads that it finished. Nothing is sent twice.
import { mount } from "nsh";
import { openDay } from "./day";
import { MockDayScreen } from "./mockFeeds";
import { openUpdate } from "./updateFeed";
import { showUpdate } from "./updateView";

const day = openDay("quiet");
const update = openUpdate("trouble");
showUpdate();
mount(() => <MockDayScreen day={day} update={update} />);
