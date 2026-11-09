// Kept changes can be read, and there are none yet.
import { mount } from "nsh";
import { openChanges } from "./changeFeed";
import { showChanges } from "./changesView";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";

const day = openDay("quiet");
const changes = openChanges("empty");
showChanges();
mount(() => <DayScreen day={day} changes={changes} />);
