// Day on the Pilot service this window's native root chose, never mock data: the window that both entries mount.
// Without a root it says it is not connected and shows nothing else. The entries (Connected.tsx and App.tsx, the
// default) call mount themselves, after NSH has given them the theme: a mount inside an imported module runs before
// the entry's theme is set, and its classes would not find the theme's colours.
import { View } from "nsh";
import { ScreenAgentBar } from "../screen-agent/ScreenAgentBar";
import { ConnectedScreenAgent, installScreenAgent } from "../screen-agent/screenAgent";
import { screenAgentAvailable } from "../screen-agent/screenAgentOpen";
import { windowId } from "../sources/bridge";
import { type Connection, connection, readAgain } from "../sources/connection";
import { Link, Notice, Page, WindowCanvas } from "../ui";
import { DayScreen } from "./DayScreen";
import { dataSource } from "./view";

dataSource.set("pilot");

// The screen agent answers this window's requests from the first read on (apps/day/screen-agent/day-screen-agent.md).
const window = windowId();
const screenAgent = window ? new ConnectedScreenAgent(window) : null;
if (window) {
	installScreenAgent(window);
	screenAgentAvailable.set(true);
}

type Open = Extract<Connection, { state: "open" }>;

export function Connected() {
	const open = () => {
		const now = connection();
		return now.state === "open" ? [now] : [];
	};
	const note = () => {
		const now = connection();
		// While Pilot will still try again by itself, it is opening, not failing.
		return now.state === "none" ? now.reason : "Opening Pilot…";
	};
	const canRead = () => {
		const now = connection();
		return now.state === "none" && now.canRead;
	};
	return (
		<If
			when={open().length > 0}
			else={
				<WindowCanvas testID="not-connected">
					<View class="flex-1 justify-center">
						<Page width="form">
							<Notice
								kind={connection().state === "none" ? "needs" : "working"}
								text={note()}
								action={
									<If when={canRead()}>
										<Link
											label="Try now"
											testID="connection-read"
											onPress={() => {
												void readAgain();
											}}
										/>
									</If>
								}
							/>
						</Page>
					</View>
				</WindowCanvas>
			}
		>
			<Each of={open()} key={() => "open"}>
				{(c) => (
					<View class="flex-1">
						<DayScreen
							day={(c() as Open).day}
							plans={(c() as Open).plans}
							rituals={(c() as Open).rituals}
							update={(c() as Open).update ?? undefined}
						/>
						<If when={screenAgent}>
							<ScreenAgentBar source={screenAgent as ConnectedScreenAgent} />
						</If>
					</View>
				)}
			</Each>
		</If>
	);
}
