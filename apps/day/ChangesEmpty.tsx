// Kept changes can be read, and there are none yet.
import { mount } from "nsh";
import { openChanges } from "./changeFeed";
import { showChanges } from "./changesView";
import { openDay } from "./day";
import { MockDayScreen } from "./mockFeeds";

const day = openDay("quiet");
const changes = openChanges("empty");
showChanges();
mount(() => <MockDayScreen day={day} changes={changes} />);
