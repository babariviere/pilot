// Kept changes: two wait for review, one is put off, the rest are history,
// one landed, and one kept change cannot be read.
import { mount } from "nsh";
import { MockDayScreen, openChanges, openDay } from "./app/testing/mockFeeds";
import { showChanges } from "./changes/changesView";

const day = openDay("quiet");
const changes = openChanges("review");
showChanges();
mount(() => <MockDayScreen day={day} changes={changes} />);
