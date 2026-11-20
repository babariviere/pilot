// Pilot's service is not registered. Registering is explicit; its answer
// is lost, and only Check again reads that it registered.
import { mount } from "nsh";
import { MockDayScreen, openDay, openUpdate } from "./app/testing/mockFeeds";
import { showUpdate } from "./updates/updateView";

const day = openDay("quiet");
const update = openUpdate("absent");
showUpdate();
mount(() => <MockDayScreen day={day} update={update} />);
