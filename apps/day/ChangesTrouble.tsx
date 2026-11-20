// The review world, but the first Later's answer is lost: it stays
// unconfirmed until Check again reads it. Nothing is sent twice.
import { mount } from "nsh";
import { MockDayScreen, openChanges, openDay } from "./app/testing/mockFeeds";
import { showChanges } from "./changes/changesView";

const day = openDay("quiet");
const changes = openChanges("trouble");
showChanges();
mount(() => <MockDayScreen day={day} changes={changes} />);
