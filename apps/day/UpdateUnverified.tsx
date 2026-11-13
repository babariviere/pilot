// Mock signature refusal, including Force's unchanged trust boundary.
import { mount } from "nsh";
import { MockDayScreen, openDay, openUpdate } from "./mockFeeds";
import { showUpdate } from "./updateView";

const day = openDay("quiet");
const update = openUpdate("unverified");
showUpdate();
mount(() => <MockDayScreen day={day} update={update} />);
