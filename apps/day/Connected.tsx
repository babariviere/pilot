// The connected entry: Day on the Pilot service this window's native root
// chose, never mock data. Without a root (`nsh run Connected.tsx`), it says
// it is not connected and shows nothing else. App.tsx, the default entry,
// runs this one.
import { mount, Text, View } from "nsh";
import { type Connection, connection, readAgain } from "./connection";
import { DayScreen } from "./DayScreen";
import { Action, Mark } from "./ui";
import { dataSource } from "./view";

dataSource.set("pilot");

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
				<View testID="not-connected" class="flex-1 items-center justify-center bg-background px-6">
					<View class="w-full max-w-md flex-row items-center gap-2.5 rounded-xl bg-muted px-4 py-3">
						<Mark kind={connection().state === "none" ? "unknown" : "still"} />
						<Text class="flex-1 text-sm text-foreground">{note()}</Text>
						<If when={canRead()}>
							<Action
								label="Read again"
								testID="connection-read"
								onPress={() => {
									void readAgain();
								}}
							/>
						</If>
					</View>
				</View>
			}
		>
			<Each of={open()} key={() => "open"}>
				{(c) => (
					<DayScreen
						day={(c() as Open).day}
						plans={(c() as Open).plans}
						rituals={(c() as Open).rituals}
						update={(c() as Open).update ?? undefined}
					/>
				)}
			</Each>
		</If>
	);
}

mount(() => <Connected />);
