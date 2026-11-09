// Kept changes: two wait for review, one is put off, the rest are history,
// one landed, and one kept change cannot be read.
import { mount } from "nsh";
import { openChanges } from "./changeFeed";
import { showChanges } from "./changesView";
import { DayScreen } from "./DayScreen";
import { openDay } from "./day";

const day = openDay("quiet");
const changes = openChanges("review");
showChanges();
mount(() => <DayScreen day={day} changes={changes} />);
