// The connected entry: Day on the Pilot service this window's native root
// chose, never mock data. Without a root (`nsh run Connected.tsx`), it says
// it is not connected and shows nothing else. App.tsx, the default entry,
// runs this one.
import { mount, View } from "nsh";
import { windowId } from "./bridge";
import { type Connection, connection, readAgain } from "./connection";
import { DayScreen } from "./DayScreen";
import { ScreenAgentBar } from "./ScreenAgentBar";
import { ConnectedScreenAgent, installScreenAgent } from "./screenAgent";
import { screenAgentAvailable } from "./screenAgentOpen";
import { Link, Notice, Page } from "./ui";
import { dataSource } from "./view";

dataSource.set("pilot");

// The screen agent answers this window's requests from the first read on (docs/technical/day-screen-agent.md).
const window = windowId();
const screenAgent = window ? new ConnectedScreenAgent(window) : null;
if (window) {
	installScreenAgent(window);
	screenAgentAvailable.set(true);
}

type Open = Extract<Connection, { state: "open" }>;

function Connected() {
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
				<View testID="not-connected" class="flex-1 justify-center">
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

mount(() => <Connected />);
