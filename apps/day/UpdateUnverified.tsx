// Mock signature refusal.
import { mount } from "nsh";
import { MockDayScreen, openDay, openUpdate } from "./app/testing/mockFeeds";
import { showUpdate } from "./updates/updateView";

const day = openDay("quiet");
const update = openUpdate("unverified");
showUpdate();
mount(() => <MockDayScreen day={day} update={update} />);
