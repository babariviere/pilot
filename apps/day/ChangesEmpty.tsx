// Kept changes can be read, and there are none yet.
import { mount } from "nsh";
import { MockDayScreen, openChanges, openDay } from "./app/testing/mockFeeds";
import { showChanges } from "./changes/changesView";

const day = openDay("quiet");
const changes = openChanges("empty");
showChanges();
mount(() => <MockDayScreen day={day} changes={changes} />);
