// Mock data. A running service does not require selected update distributions.
// This fixture uses the real update screen but never connects or updates anything.
import { mount } from "nsh";
import { openDay, openUpdate } from "./mockFeeds";
import { UpdateScreen } from "./UpdateScreen";
import { Block, Caption, WindowCanvas } from "./ui";

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

mount(() => (
	<WindowCanvas>
		<Block>
			<Caption tone="faint">Mock data. Service status without update packages.</Caption>
		</Block>
		<UpdateScreen day={day} update={update} />
	</WindowCanvas>
));
