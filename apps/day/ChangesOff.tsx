// Pilot cannot read kept changes here. Never shown as none.
import { mount } from "nsh";
import { openChanges } from "./changeFeed";
import { showChanges } from "./changesView";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";

const day = openDay("quiet");
const changes = openChanges("unavailable");
showChanges();
mount(() => <DayScreen day={day} changes={changes} />);
