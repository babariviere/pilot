// Kept changes can be read, and there are none yet.
import { mount } from "nsh";
import { showChanges } from "./changesView";
import { MockDayScreen, openChanges, openDay } from "./mockFeeds";

const day = openDay("quiet");
const changes = openChanges("empty");
showChanges();
mount(() => <MockDayScreen day={day} changes={changes} />);
