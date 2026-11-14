// Mock data. A running service does not require selected update distributions.
// This fixture uses the real update screen but never connects or updates anything.
import { mount, Text, View } from "nsh";
import { openDay, openUpdate } from "./mockFeeds";
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
	blocked: "The signed official update and rollback distributions are not selected. Nothing was changed.",
});

mount(() => (
	<View class="flex-1 bg-background">
		<Text class="px-6 pt-4 text-xs text-faint">Mock data. Service status without update packages.</Text>
		<UpdateScreen day={day} update={update} />
	</View>
));
