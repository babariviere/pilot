// Mock signature refusal, including Force's unchanged trust boundary.
import { mount } from "nsh";
import { openDay } from "./day";
import { MockDayScreen } from "./mockFeeds";
import { openUpdate } from "./updateFeed";
import { showUpdate } from "./updateView";

const day = openDay("quiet");
const update = openUpdate("unverified");
showUpdate();
mount(() => <MockDayScreen day={day} update={update} />);
