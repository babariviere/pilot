// The review world, but the first Later's answer is lost: it stays
// unconfirmed until Check again reads it. Nothing is sent twice.
import { mount } from "nsh";
import { openChanges } from "./changeFeed";
import { showChanges } from "./changesView";
import { openDay } from "./day";
import { MockDayScreen } from "./mockFeeds";

const day = openDay("quiet");
const changes = openChanges("trouble");
showChanges();
mount(() => <MockDayScreen day={day} changes={changes} />);
