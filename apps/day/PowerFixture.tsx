// A window whose Pilot paused work for sleep: the header offers Resume work.
// Mock data only. The first Resume is not confirmed, to show its message.
import { mount } from "nsh";
import { MockDayScreen, openDay } from "./app/testing/mockFeeds";
import { type PowerView, powerControls } from "./updates/power";

let view: PowerView = { paused: true, since: Date.now() - 20 * 60_000 };
let resumes = 0;
const power = powerControls(async (name) => {
	if (name === "resume" && ++resumes === 1) return null;
	if (name === "resume") view = { paused: false, since: null };
	return view;
});
void power.read();
const day = { ...openDay("quiet"), power };
mount(() => <MockDayScreen day={day} />);
