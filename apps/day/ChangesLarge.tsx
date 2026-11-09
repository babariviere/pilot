// 45 kept changes, read 20 at a time, and one 1,200-line diff.
import { mount } from "nsh";
import { openChanges } from "./changeFeed";
import { showChanges } from "./changesView";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";

const day = openDay("quiet");
const changes = openChanges("large");
showChanges();
mount(() => <DayScreen day={day} changes={changes} />);
