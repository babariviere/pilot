// 45 kept changes, read 20 at a time, and one 1,200-line diff.
import { mount } from "nsh";
import { showChanges } from "./changesView";
import { MockDayScreen, openChanges, openDay } from "./mockFeeds";

const day = openDay("quiet");
const changes = openChanges("large");
showChanges();
mount(() => <MockDayScreen day={day} changes={changes} />);
