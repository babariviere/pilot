// Mock data. A running service does not require selected update distributions.
// This fixture uses the real update screen but never connects or updates anything.
import { type JSX, mount, View } from "nsh";
import { openDay, openUpdate } from "./mockFeeds";
import { Block, Caption, GridBackdrop } from "./ui";
import { UpdateScreen } from "./UpdateScreen";

const day = openDay("quiet");
const update = openUpdate("current");
update.service.set({
	...update.service(),
	state: "registered",
	app: "20261114.204",
	service: "1.125.0",
	agents: [],
	forceAvailable: false,
	blocked: "Automatic updates are not set up for this install. Install new versions with the Pilot installer.",
});

// LIBRARY GAP: no part paints a window's canvas (the background colour and GridBackdrop) for a fixture that mounts
// a screen or a control without DayScreen. This local root does what DayScreen's root does.
function FixtureWindow(props: { children?: JSX.Element }) {
	return (
		<View class="flex-1 bg-background">
			<GridBackdrop />
			{props.children}
		</View>
	);
}

mount(() => (
	<FixtureWindow>
		<Block>
			<Caption tone="faint">Mock data. Service status without update packages.</Caption>
		</Block>
		<UpdateScreen day={day} update={update} />
	</FixtureWindow>
));
