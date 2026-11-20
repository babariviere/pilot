// Pilot cannot read kept changes here. Never shown as none.
import { mount } from "nsh";
import { MockDayScreen, openChanges, openDay } from "./app/testing/mockFeeds";
import { showChanges } from "./changes/changesView";

const day = openDay("quiet");
const changes = openChanges("unavailable");
showChanges();
mount(() => <MockDayScreen day={day} changes={changes} />);
