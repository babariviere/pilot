// Pilot cannot read kept changes here. Never shown as none.
import { mount } from "nsh";
import { showChanges } from "./changesView";
import { MockDayScreen, openChanges, openDay } from "./mockFeeds";

const day = openDay("quiet");
const changes = openChanges("unavailable");
showChanges();
mount(() => <MockDayScreen day={day} changes={changes} />);
