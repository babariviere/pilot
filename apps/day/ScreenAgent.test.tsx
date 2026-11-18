// The screen agent's registry through the real request handler, with scripted native replies. No service.
import { expect, open, test } from "nsh/test";
import type { ActResult, AgentComponent, Snapshot } from "./ui";
import type { ScreenAnswer, ScreenOperation, ScreenRequest } from "./screenAgentContract";

async function fixture() {
	const waiting: ScreenRequest[] = [];
	const answers = new Map<string, ScreenAnswer>();
	const sent: string[] = [];
	let next = 0;
	const app = await open("./ScreenAgentFixture.tsx", {
		platform: "macos",
		width: 900,
		height: 1200,
		host: { params: { day: { version: 1, window: "fixture" } } },
		modules: {
			nsh: {
				"host.call": (name: string, envelope: { window: string; args: { id: string; answer: ScreenAnswer } }) => {
					expect(envelope.window).toBe("fixture");
					sent.push(name);
					if (name === "day.screen.take")
						return { version: 1, value: { snapshot: waiting.splice(0), outcome: null } };
					if (name === "day.screen.answer") {
						answers.set(envelope.args.id, envelope.args.answer);
						return { version: 1, value: { snapshot: null, outcome: null } };
					}
					if (name === "day.today.read") return { version: 1, value: { snapshot: null, outcome: null } };
					return { version: 1, error: "unavailable" };
				},
			},
		},
	});
	const ask = async (operation: ScreenOperation): Promise<ScreenAnswer> => {
		const id = `r${next++}`;
		waiting.push({ id, sessionId: "s", windowId: "fixture", operation, deadline: Date.now() + 5000 });
		await app.host.send("day.screen.requested", { version: 1, window: "fixture" });
		await app.waitUntil(() => answers.has(id));
		return answers.get(id) as ScreenAnswer;
	};
	const snap = async () => ((await ask({ op: "snapshot" })) as { ok: true; value: Snapshot }).value;
	const act = async (steps: { ref: string; action: string; args?: unknown[] }[]) =>
		((await ask({ op: "act", steps })) as { ok: true; value: ActResult }).value;
	const byLabel = (s: Snapshot, label: string) => s.components.find((c) => c.label === label) as AgentComponent;
	return { app, ask, snap, act, byLabel, sent };
}

test("snapshot lists controls with refs, state and marks, and leaves hidden ones out", async () => {
	const { snap, byLabel } = await fixture();
	const s = await snap();
	expect(s.screen.place).toBe("today");
	expect(byLabel(s, "Save")).toMatchObject({ component: "button", id: "save", actions: ["press"] });
	expect(byLabel(s, "Project name")).toMatchObject({ component: "input", value: "Apollo" });
	expect(byLabel(s, "Token").value).toBe("[redacted]");
	expect(byLabel(s, "Region")).toMatchObject({
		component: "select",
		value: "eu",
		items: [
			{ value: "eu", label: "Europe" },
			{ value: "na", label: "North America" },
		],
	});
	expect(byLabel(s, "Email me")).toMatchObject({ component: "checkbox", checked: false });
	expect(byLabel(s, "Start work").confirm).toBe("Starts agents on this plan");
	expect(byLabel(s, "Last read failed")).toMatchObject({ component: "status", text: "Pilot tries again by itself." });
	expect(s.components.some((c) => c.label === "Hidden thing")).toBe(false);
	expect(s.components.every((c) => /^c\d+$/.test(c.ref))).toBe(true);
});

test("act runs steps through the page's own callbacks and reports what changed", async () => {
	const { app, act, snap, byLabel } = await fixture();
	const r = await act([
		{ ref: "Project name", action: "setValue", args: ["Atlas"] },
		{ ref: "Region", action: "setValue", args: ["north america"] },
		{ ref: "save", action: "press" },
	]);
	expect(r.ok).toBe(true);
	expect(r.steps[0].changes?.[0]).toMatchObject({ key: "value", value: "Atlas", previous: "Apollo" });
	expect(app.shows("text:save")).toBe(true);
	const s = await snap();
	expect(byLabel(s, "Region").value).toBe("na");
	expect(byLabel(s, "Project name").value).toBe("Atlas");
});

test("a marked control needs a person, and later steps do not run", async () => {
	const { app, act } = await fixture();
	const r = await act([
		{ ref: "Start work", action: "press" },
		{ ref: "save", action: "press" },
	]);
	expect(r.ok).toBe(false);
	expect(r.error?.step).toBe(0);
	expect(r.error?.message).toMatch(/^Needs a person: "Starts agents on this plan"/);
	expect(app.shows("text:nothing")).toBe(true);
});

test("ambiguous, unknown, hidden and wrong-value steps fail with what to do", async () => {
	const { act } = await fixture();
	expect((await act([{ ref: "Save", action: "press" }])).error?.message).toMatch(/names 2 components: .*Use a ref/);
	expect((await act([{ ref: "Hidden thing", action: "press" }])).error?.message).toMatch(/Nothing on this window/);
	expect((await act([{ ref: "Region", action: "setValue", args: ["Asia"] }])).error?.message).toMatch(
		/^No item "Asia" in c\d+ Region\. Its items: Europe, North America\.$/,
	);
	expect((await act([{ ref: "Email me", action: "setChecked", args: ["yes"] }])).error?.message).toMatch(
		/takes true or false/,
	);
	expect((await act([{ ref: "Save draft", action: "toggle" }])).error?.message).toMatch(
		/takes no toggle\. It takes: press/,
	);
});

test("opening a disclosure reports what appeared, and the person's changes show in the next snapshot", async () => {
	const { app, act, snap } = await fixture();
	await snap();
	const r = await act([{ ref: "More options", action: "setOpen", args: [true] }]);
	expect(r.ok).toBe(true);
	expect((r.appeared ?? []).some((a) => a.includes("Inner"))).toBe(true);
	await app.press("text:Email me");
	const s = await snap();
	expect(s.changes.find((c) => c.label === "Email me")).toMatchObject({
		key: "checked",
		value: true,
		previous: false,
	});
	expect(s.changes.some((c) => c.label === "More options")).toBe(false);
});

test("query finds a list's choices by text without opening it", async () => {
	const { ask } = await fixture();
	const r = (await ask({ op: "query", within: "Region", text: "eur" })) as { ok: true; value: AgentComponent[] };
	expect(r.value[0].items).toEqual([{ value: "eu", label: "Europe" }]);
	const none = await ask({ op: "query" });
	expect(none).toEqual({ ok: false, error: "Pass text, within or kind." });
});

test("a control that would write to Pilot is refused at the bridge, even after a read", async () => {
	const { act, sent } = await fixture();
	const pause = await act([{ ref: "Pause mission", action: "press" }]);
	expect(pause.error?.message).toMatch(/^Needs a person: "Pause mission" writes to Pilot \(day\.mission\.pause\)/);
	const archive = await act([{ ref: "Archive mission", action: "press" }]);
	expect(archive.error?.message).toMatch(/day\.mission\.archive/);
	expect(sent.includes("day.today.read")).toBe(true);
	expect(sent.some((n) => n === "day.mission.pause" || n === "day.mission.archive")).toBe(false);
});

test("query lists one kind", async () => {
	const { ask } = await fixture();
	const r = (await ask({ op: "query", kind: "tab" })) as { ok: true; value: AgentComponent[] };
	expect(r.value.map((c) => [c.label, c.selected])).toEqual([
		["One", true],
		["Two", false],
	]);
});
