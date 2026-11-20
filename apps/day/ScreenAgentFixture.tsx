// Test-only: styled controls and the screen agent's request handling over the injected native host channel.
// Every control and value here is invented.
import { mount, signal } from "nsh";
import { installScreenAgent } from "./screen-agent/screenAgent";
import { call } from "./sources/bridge";
import {
	AgentScope,
	Block,
	Body,
	Button,
	Buttons,
	Checkbox,
	Disclosure,
	Field,
	Notice,
	Picker,
	Tab,
	Tabs,
	WindowCanvas,
} from "./ui";

const name = signal("Apollo");
const token = signal("hunter2");
const region = signal<string | null>("eu");
const email = signal(false);
const tab = signal("one");
const more = signal(false);
const pressed = signal("");

installScreenAgent("fixture");

mount(() => (
	<WindowCanvas>
		<Block>
			<Body testID="pressed">{pressed() || "nothing"}</Body>
			<Buttons>
				<Button label="Save" testID="save" onPress={() => pressed.set("save")} />
				<Button label="Save draft" onPress={() => pressed.set("draft")} />
				<Button
					label="Pause mission"
					onPress={() => void call("fixture", "day.mission.pause", { missionId: "m" })}
				/>
				<Button
					label="Archive mission"
					onPress={async () => {
						await call("fixture", "day.today.read", {});
						await call("fixture", "day.mission.archive", { missionId: "m" });
					}}
				/>
				<Button
					label="Start work"
					agent={{ confirm: "Starts agents on this plan" }}
					onPress={() => pressed.set("start")}
				/>
			</Buttons>
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
			<Checkbox label="Email me" checked={email()} onChange={() => email.set(!email())} />
			<Tabs>
				<Tab label="One" selected={tab() === "one"} onPress={() => tab.set("one")} />
				<Tab label="Two" selected={tab() === "two"} onPress={() => tab.set("two")} />
			</Tabs>
			<Disclosure label="More options" open={more()} onToggle={() => more.set(!more())}>
				<If when={more()}>
					<Button label="Inner" onPress={() => pressed.set("inner")} />
				</If>
			</Disclosure>
			<AgentScope.Provider value={{ hidden: true }}>
				<Button label="Hidden thing" onPress={() => pressed.set("hidden")} />
			</AgentScope.Provider>
			<Notice text="Last read failed" detail="Pilot tries again by itself." />
		</Block>
	</WindowCanvas>
));
