import { host, mount } from "nsh";
import { MockDayScreen, openDay, openUpdate } from "./app/testing/mockFeeds";
import { showUpdate } from "./updates/updateView";

const scenario = (host.params as { scenario?: unknown } | undefined)?.scenario;
if (scenario !== "absent" && scenario !== "denied" && scenario !== "offline" && scenario !== "newer")
	throw new Error("Select an update service fixture scenario");
const day = openDay(scenario === "offline" ? "offline" : "quiet");
const update = openUpdate(scenario);
showUpdate();
mount(() => <MockDayScreen day={day} update={update} />);
