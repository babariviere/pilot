// Mock signature refusal, including Force's unchanged trust boundary.
import { mount } from "nsh";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";
import { openUpdate } from "./updateFeed";
import { showUpdate } from "./updateView";

const day = openDay("quiet");
const update = openUpdate("unverified");
showUpdate();
mount(() => <DayScreen day={day} update={update} />);
