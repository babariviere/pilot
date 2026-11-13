// Kept changes: two wait for review, one is put off, the rest are history,
// one landed, and one kept change cannot be read.
import { mount } from "nsh";
import { openChanges } from "./changeFeed";
import { showChanges } from "./changesView";
import { openDay } from "./day";
import { MockDayScreen } from "./mockFeeds";

const day = openDay("quiet");
const changes = openChanges("review");
showChanges();
mount(() => <MockDayScreen day={day} changes={changes} />);
