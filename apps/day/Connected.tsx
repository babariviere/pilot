// The connected entry: Day on the Pilot service this window's native root
// chose, never mock data. Without a root (`nsh run Connected.tsx`), it says
// it is not connected and shows nothing else. The default entry (App.tsx)
// stays on mock data.
import { mount, Text, View } from "nsh";
import { type Connection, connection } from "./connection";
import { DayScreen } from "./DayScreen";
import { Mark } from "./ui";
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
		return now.state === "none" ? now.reason : "Opening Pilot…";
	};
	return (
		<If
			when={open().length > 0}
			else={
				<View testID="not-connected" class="flex-1 items-center justify-center bg-background px-6">
					<View class="w-full max-w-md flex-row items-center gap-2.5 rounded-xl bg-muted px-4 py-3">
						<Mark kind={connection().state === "none" ? "unknown" : "still"} />
						<Text class="flex-1 text-sm text-foreground">{note()}</Text>
					</View>
				</View>
			}
		>
			<Each of={open()} key={() => "open"}>
				{(c) => <DayScreen day={(c() as Open).day} plans={(c() as Open).plans} />}
			</Each>
		</If>
	);
}

mount(() => <Connected />);
