// Test-only: styled controls and the screen agent's request handling over the injected native host channel.
// Every control and value here is invented.
import { mount, signal, Text, View } from "nsh";
import { call } from "./bridge";
import { installScreenAgent } from "./screenAgent";
import { Action, AgentScope, CheckboxRow, Disclosure, Field, Notice, Picker, TabItem, TabRow } from "./ui";

const name = signal("Apollo");
const token = signal("hunter2");
const region = signal<string | null>("eu");
const email = signal(false);
const tab = signal("one");
const more = signal(false);
const pressed = signal("");

installScreenAgent("fixture");

mount(() => (
	<View class="flex-1 gap-2 bg-background p-4">
		<Text testID="pressed">{pressed() || "nothing"}</Text>
		<Action label="Save" testID="save" onPress={() => pressed.set("save")} />
		<Action label="Save draft" onPress={() => pressed.set("draft")} />
		<Action label="Pause mission" onPress={() => void call("fixture", "day.mission.pause", { missionId: "m" })} />
		<Action
			label="Archive mission"
			onPress={async () => {
				await call("fixture", "day.today.read", {});
				await call("fixture", "day.mission.archive", { missionId: "m" });
			}}
		/>
		<Action
			label="Start work"
			agent={{ confirm: "Starts agents on this plan" }}
			onPress={() => pressed.set("start")}
		/>
		<Field label="Project name" value={name()} onChange={(v) => name.set(v)} />
		<Field label="Token" masked value={token()} onChange={(v) => token.set(v)} />
		<Picker
			label="Region"
			placeholder="Choose a region"
			items={[
				{ value: "eu", title: "Europe" },
				{ value: "na", title: "North America" },
			]}
			value={region()}
			onChange={(v) => region.set(v)}
		/>
		<CheckboxRow label="Email me" checked={email()} onChange={() => email.set(!email())} />
		<TabRow>
			<TabItem label="One" selected={tab() === "one"} onPress={() => tab.set("one")} />
			<TabItem label="Two" selected={tab() === "two"} onPress={() => tab.set("two")} />
		</TabRow>
		<Disclosure label="More options" open={more()} onToggle={() => more.set(!more())}>
			<If when={more()}>
				<Action label="Inner" onPress={() => pressed.set("inner")} />
			</If>
		</Disclosure>
		<AgentScope.Provider value={{ hidden: true }}>
			<Action label="Hidden thing" onPress={() => pressed.set("hidden")} />
		</AgentScope.Provider>
		<Notice text="Last read failed" detail="Pilot tries again by itself." />
	</View>
));
