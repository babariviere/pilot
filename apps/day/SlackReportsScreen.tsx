import { effect, Keyboard, keymap, List, signal, View } from "nsh";
import { openChat } from "./chatView";
import type { Day } from "./day";
import { IntakeWorkControls } from "./Incoming";
import { keepScroll } from "./kept";
import type { ReportDetails, ReportEvidence, SlackControls, SlackReport } from "./slackControls";
import { closeSlack, selectedSlackReport, slackEdit, slackGroupEdit, slackOffset, slackProject } from "./slackView";
import {
	Block,
	Body,
	BodyStrong,
	Button,
	Buttons,
	Caption,
	Checkbox,
	EmptyLine,
	Field,
	Link,
	Notice,
	PageHead,
	PanelSlice,
	Picker,
	ReadField,
	Row,
	Section,
	Spacer,
} from "./ui";
import { openMission } from "./view";

const EMPTY: ReportDetails = { client: null, reporter: null, issue: null };
const NAMES = { client: "Client organization", reporter: "Original reporter", issue: "Issue" };
const KEYS = ["client", "reporter", "issue"] as const;
type ListRow = { id: string; group: string; title: string; item?: SlackReport };
type SlackDay = Pick<Day, "slack" | "intake" | "chat"> & Partial<Pick<Day, "today">>;
function details(i: SlackReport): ReportDetails {
	return { ...EMPTY, ...i.metadata.details, ...i.slack?.overrides.details };
}
function status(i: SlackReport) {
	if (i.slack?.status === "done" && i.slack.overrides.status !== "done") return "Previously marked done";
	return (
		{ done: "Tackled by you", in_progress: "Work started", waiting: "Waiting for a reply", dismissed: "Set aside" }[
			i.slack?.status ?? ""
		] ?? "Open"
	);
}

function Corrections(props: { controls: SlackControls; locked: boolean }) {
	const d = () => slackEdit()!;
	const valid = () =>
		KEYS.every((k) => {
			const f = d().details[k];
			return (
				!f ||
				(!f.value.trim() && !f.evidence.trim()) ||
				(!!f.value.trim() && !!f.evidence.trim() && f.value.length <= 240 && f.evidence.length <= 500)
			);
		});
	const change = (key: keyof ReportDetails, part: keyof ReportEvidence, value: string) => {
		const before = d();
		const old = before.details[key] ?? { value: "", evidence: "" };
		slackEdit.set({ ...before, details: { ...before.details, [key]: { ...old, [part]: value } } });
	};
	return (
		<View class="gap-4">
			<View class="gap-1">
				<BodyStrong>Correct report details</BodyStrong>
				<Caption>
					Leave both fields empty for Not identified. A named original reporter needs source evidence, not the
					Slack author's name.
				</Caption>
			</View>
			<Each of={KEYS} key={(k) => k}>
				{(key) => (
					<View class="gap-2">
						<Field
							label={NAMES[key()]}
							testID={`slack-edit-${key()}`}
							value={d().details[key()]?.value ?? ""}
							onChange={(v) => change(key(), "value", v)}
						/>
						<Field
							label={`${NAMES[key()]} evidence`}
							testID={`slack-evidence-${key()}`}
							value={d().details[key()]?.evidence ?? ""}
							onChange={(v) => change(key(), "evidence", v)}
						/>
					</View>
				)}
			</Each>
			<If
				when={
					props.controls.snapshot()?.reports?.digest !== d().digest ||
					props.controls.snapshot()?.binding !== d().binding
				}
			>
				<Caption tone="needs">Reports changed. Your draft is kept. Cancel and correct the current report.</Caption>
			</If>
			<Buttons>
				<Button
					label="Save corrections"
					testID="slack-corrections-save"
					disabled={
						props.locked ||
						!valid() ||
						props.controls.snapshot()?.reports?.digest !== d().digest ||
						props.controls.snapshot()?.binding !== d().binding
					}
					onPress={async () => {
						const draft = d();
						const value = Object.fromEntries(
							KEYS.map((k) => [
								k,
								draft.details[k]?.value.trim() || draft.details[k]?.evidence.trim() ? draft.details[k] : null,
							]),
						);
						if (
							await props.controls.write(
								"report",
								{
									digest: draft.digest,
									offset: draft.offset ?? 0,
									itemId: draft.itemId,
									patch: { details: value },
								},
								draft.binding,
							)
						) {
							Keyboard.dismiss();
							slackEdit.set(null);
						}
					}}
				/>
				<Button
					label="Cancel"
					onPress={() => {
						Keyboard.dismiss();
						slackEdit.set(null);
					}}
				/>
			</Buttons>
		</View>
	);
}

function GroupEditor(props: { controls: SlackControls; locked: boolean }) {
	const d = () => slackGroupEdit()!;
	const s = () => props.controls.snapshot();
	const members = () => s()?.reports?.items.filter((i) => i.caseId === d().caseId) ?? [];
	const valid = () =>
		d().action === "merge"
			? !!d().targetId
			: !!d().name.trim() && d().name.length <= 80 && (d().action !== "split" || d().itemIds.length > 0);
	return (
		<Block gap={3}>
			<Picker
				label="Group action"
				value={d().action}
				placeholder="Group action"
				items={[
					{ value: "rename", title: "Rename group" },
					{ value: "merge", title: "Merge groups" },
					{ value: "split", title: "Split reports" },
				]}
				onChange={(v) => slackGroupEdit.set({ ...d(), action: v as "rename" | "merge" | "split" })}
			/>
			<If when={d().action !== "merge"}>
				<Field
					label="Group name"
					testID="slack-group-name"
					value={d().name}
					onChange={(v) => slackGroupEdit.set({ ...d(), name: v })}
				/>
			</If>
			<If when={d().action === "merge"}>
				<Picker
					label="Merge into"
					placeholder="Choose target group"
					value={d().targetId}
					items={(s()?.reports?.groups ?? [])
						.filter((g) => g.id !== d().caseId)
						.map((g) => ({ value: g.id, title: g.name }))}
					onChange={(v) => slackGroupEdit.set({ ...d(), targetId: v })}
				/>
			</If>
			<If when={d().action === "split"}>
				<Each of={members()} key={(i) => i.id}>
					{(i) => (
						<Checkbox
							label={i().title}
							checked={d().itemIds.includes(i().id)}
							onChange={() =>
								slackGroupEdit.set({
									...d(),
									itemIds: d().itemIds.includes(i().id)
										? d().itemIds.filter((id) => id !== i().id)
										: [...d().itemIds, i().id],
								})
							}
						/>
					)}
				</Each>
			</If>
			<If when={s()?.reports?.digest !== d().digest || s()?.binding !== d().binding}>
				<Caption tone="needs">Reports changed. Your draft is kept. Cancel and edit the current group.</Caption>
			</If>
			<Buttons>
				<Button
					label="Save group"
					testID="slack-group-save"
					disabled={
						props.locked || !valid() || s()?.reports?.digest !== d().digest || s()?.binding !== d().binding
					}
					onPress={async () => {
						const draft = d();
						const edit =
							draft.action === "rename"
								? { action: "rename", name: draft.name }
								: draft.action === "merge"
									? { action: "merge", targetId: draft.targetId }
									: { action: "split", name: draft.name, itemIds: draft.itemIds };
						if (
							await props.controls.write(
								"group",
								{ digest: draft.digest, offset: draft.offset ?? 0, caseId: draft.caseId, edit },
								draft.binding,
							)
						) {
							Keyboard.dismiss();
							slackGroupEdit.set(null);
						}
					}}
				/>
				<Button
					label="Cancel"
					onPress={() => {
						Keyboard.dismiss();
						slackGroupEdit.set(null);
					}}
				/>
			</Buttons>
		</Block>
	);
}

function Report(props: { item: SlackReport; day: SlackDay; controls: SlackControls; locked: boolean }) {
	const i = () => props.item;
	const s = () => props.controls.snapshot()!;
	const mutate = (patch: unknown) =>
		props.controls.write(
			"report",
			{ digest: s().reports!.digest, offset: s().reports!.offset ?? 0, itemId: i().id, patch },
			s().binding,
		);
	const intake = () => (props.day.intake?.view().projectId === s().projectId ? props.day.intake : null);
	const missions = () => {
		const t = props.day.today?.();
		return t
			? [...t.moving, ...t.notMoving, ...t.unreported].filter(
					(m) => m.control.state === "running" && !m.control.held,
				)
			: [];
	};
	return (
		// The report's row opens its details in place, below the row, while it is the selected report.
		<Row
			testID={`slack-report-${i().id}`}
			title={i().title}
			meta={i().metadata.channelName ? `#${i().metadata.channelName}` : "Slack"}
			state={status(i())}
			selected={selectedSlackReport() === i().id}
			open={selectedSlackReport() === i().id}
			onToggle={() => selectedSlackReport.set(selectedSlackReport() === i().id ? null : i().id)}
			accessibilityLabel={`${i().title}, ${status(i())}. Show report details.`}
			content={
				<If when={selectedSlackReport() === i().id}>
					<View class="gap-4">
						<Buttons>
							<BodyStrong>Report details</BodyStrong>
							<Spacer />
							<Button
								small
								label="Correct details…"
								disabled={props.locked || !!slackEdit()}
								onPress={() =>
									slackEdit.set({
										projectId: s().projectId,
										binding: s().binding,
										digest: s().reports!.digest,
										offset: s().reports!.offset ?? 0,
										itemId: i().id,
										details: details(i()),
									})
								}
							/>
						</Buttons>
						<View class="flex-row flex-wrap gap-4">
							<ReadField
								label="Client organization"
								value={details(i()).client?.value ?? "Not identified"}
								evidence={details(i()).client?.evidence ?? "No organization identified in the saved evidence."}
							/>
							<ReadField
								label="Slack author"
								value={i().metadata.author ?? "Not identified"}
								evidence="Author of the source Slack message"
							/>
							<ReadField
								label="Original reporter"
								value={details(i()).reporter?.value ?? "Not identified"}
								evidence={
									details(i()).reporter?.evidence ?? "No original reporter identified in the saved evidence."
								}
							/>
						</View>
						<ReadField
							label="Issue"
							value={details(i()).issue?.value ?? "Not identified"}
							evidence={details(i()).issue?.evidence ?? "No issue identified in the saved evidence."}
						/>
						<View selectable>
							<Caption tone="faint">{i().url}</Caption>
						</View>
						<If when={props.controls.open && s().canOpenUrl !== false}>
							<View class="flex-row">
								<Button
									small
									label="Source message"
									disabled={props.locked}
									onPress={() => void props.controls.open?.(i().id, s().reports!.digest, s().binding)}
								/>
							</View>
						</If>
						<If when={slackEdit()?.itemId === i().id}>
							<Corrections controls={props.controls} locked={props.locked} />
						</If>
						<Buttons>
							<Caption>{`Label: ${i().slack?.label ?? "None"} · ${i().slack?.severity ?? "Not identified"} severity`}</Caption>
							<Picker
								label="Report label"
								value={i().slack?.label ?? ""}
								placeholder="No label"
								disabled={props.locked}
								items={[
									{ value: "", title: "No label" },
									...(s().labels ?? []).map((l) => ({ value: l.name, title: l.name })),
								]}
								onChange={(v) => void mutate({ label: v || null })}
							/>
						</Buttons>
						<Caption tone="faint">Labels organize or hide reports. They never mark tackled.</Caption>
						<Buttons>
							<If when={i().sessionId && props.day.chat}>
								<Button
									small
									label="View linked work"
									onPress={() => openChat(i().sessionId!, "Slack reports")}
								/>
							</If>
							<If when={i().missionId}>
								<Button
									small
									label="View linked mission"
									onPress={() => {
										closeSlack();
										openMission(i().missionId!);
									}}
								/>
							</If>
							<Button
								small
								label={i().slack?.status === "done" ? "Mark open" : "Mark tackled"}
								testID={`slack-tackle-${i().id}`}
								disabled={props.locked}
								onPress={() => void mutate({ status: i().slack?.status === "done" ? "open" : "done" })}
							/>
						</Buttons>
						<If
							when={
								!i().sessionId && !i().missionId && !i().startOperationId && i().slack?.status === "open"
									? intake()
									: null
							}
						>
							{(mirror) => (
								<If
									when={i().triageState === "new"}
									else={
										<View class="flex-row">
											<Button
												small
												label="Bring back"
												disabled={props.locked}
												onPress={async () => {
													const v = mirror().view();
													const result = await mirror().source.triage({
														itemId: i().id,
														revision: i().revision,
														contextDigest: v.contextDigest,
														state: "new",
													});
													if (result.status === "accepted") await props.controls.read();
												}}
											/>
										</View>
									}
								>
									<IntakeWorkControls
										mirror={mirror()}
										row={{
											revision: i().revision,
											request: {
												id: i().id,
												title: i().title,
												source: "slack",
												sourceLabel: "Slack",
												place: i().metadata.channelName ?? "",
												age: "",
												link: i().url,
												kind: i().slack?.type ?? "",
												who: "",
												quote: "",
												client: "",
												reporter: "",
											},
										}}
										missions={missions()}
										busy={
											props.locked ||
											mirror().view().sending.includes(i().id) ||
											mirror()
												.view()
												.unsettled.some((o) => o.itemId === i().id)
										}
										onStarted={() => void props.controls.read()}
									/>
								</If>
							)}
						</If>

						<Each
							of={
								intake()
									?.view()
									.unsettled.filter((o) => o.itemId === i().id) ?? []
							}
							key={(o) => o.operationId}
						>
							{(o) => (
								<Notice
									kind="unconfirmed"
									text="Starting this work is not confirmed. It will not be started again."
									action={
										<Link
											label="Check start status"
											disabled={o().delivery === "checking"}
											onPress={async () => {
												await intake()?.source.check(o().operationId);
												await props.controls.read();
											}}
										/>
									}
								/>
							)}
						</Each>
						<Caption tone="faint">
							Starting work does not mark tackled. Only a start reaction is sent to Slack.
						</Caption>
					</View>
				</If>
			}
		/>
	);
}

export function SlackReportsScreen(props: { day: SlackDay }) {
	const c = props.day.slack!;
	void c.read(slackOffset());
	void props.day.intake?.source.read();
	const s = () => c.snapshot();
	effect(() => {
		const v = s();
		if (v && slackProject() === null) slackProject.set(v.projectId);
		if (v?.reports && v.projectId === slackProject()) slackOffset.set(v.reports.offset ?? 0);
	});
	const here = () => s()?.projectId === slackProject();
	const locked = () => c.busy() || !!c.unknown().length || !here();
	const showTackled = signal(false);
	const showHidden = signal(false);
	const visible = () =>
		s()?.reports?.items.filter(
			(i) =>
				(showTackled() || i.slack?.status !== "done") &&
				(showHidden() ||
					!["hide", "close"].includes(s()?.labels?.find((l) => l.name === i.slack?.label)?.effect ?? "")),
		) ?? [];
	const rows = (): ListRow[] => {
		if (!here()) return [];
		const grouped = new Map<string, SlackReport[]>();
		for (const i of visible()) {
			const id = i.caseId ?? "";
			grouped.set(id, [...(grouped.get(id) ?? []), i]);
		}
		return [...grouped].flatMap(([id, items]) => [
			{
				id: `group:${id}`,
				group: id,
				title: s()?.reports?.groups.find((g) => g.id === id)?.name ?? "Ungrouped reports",
			},
			...items.map((item) => ({ id: item.id, group: id, title: item.title, item })),
		]);
	};
	keymap.bind(
		"escape",
		() => {
			Keyboard.dismiss();
			if (slackEdit()) slackEdit.set(null);
			else if (slackGroupEdit()) slackGroupEdit.set(null);
			else if (selectedSlackReport()) selectedSlackReport.set(null);
			else closeSlack();
		},
		{ when: "always" },
	);
	const head = (
		<View>
			{/* The List scrolls the whole page, so the page and its panel come in slices. */}
			<PanelSlice part="head">
				<PageHead
					title="Slack reports"
					text={`${s()?.projectName ?? "Reading saved reports…"} · Coverage is incomplete`}
					actions={<Button label="Read again" disabled={c.busy()} onPress={() => void c.read()} />}
				>
					<If when={c.message()}>
						<Body tone="needs">{c.message()}</Body>
					</If>
				</PageHead>
			</PanelSlice>
			<PanelSlice part="top">
				<Each of={c.unknown()} key={(o) => o.operationId}>
					{(o) => (
						<Notice
							placement="panel"
							kind="unconfirmed"
							text="This Slack action is not confirmed. It will not be sent again."
							action={
								<Link label="Check status" disabled={c.busy()} onPress={() => void c.check(o().operationId)} />
							}
						/>
					)}
				</Each>
				<If when={s() && !here()}>
					<Notice placement="panel" text="These reports belong to another project. Nothing is shown or changed." />
				</If>
				<If when={here() && !s()?.reports}>
					<Notice placement="panel" text="Slack reports are unavailable. Read again; this is not an empty list." />
				</If>
				<Block>
					<Buttons>
						<Button
							small
							label={showTackled() ? "Hide tackled" : "Show tackled"}
							onPress={() => showTackled.set(!showTackled())}
						/>
						<Button
							small
							label={showHidden() ? "Hide labeled reports" : "Show hidden labels"}
							onPress={() => showHidden.set(!showHidden())}
						/>
						<Spacer />
						<If when={here() && s()?.reports && ((s()?.reports?.offset ?? 0) > 0 || s()?.reports?.more)}>
							<Button
								small
								label="Previous reports"
								disabled={locked() || !s()?.reports?.offset}
								onPress={() => {
									selectedSlackReport.set(null);
									void c.read(Math.max(0, (s()?.reports?.offset ?? 0) - 100));
								}}
							/>
							<Button
								small
								label="Next reports"
								disabled={locked() || !s()?.reports?.more}
								onPress={() => {
									selectedSlackReport.set(null);
									void c.read((s()?.reports?.offset ?? 0) + 100);
								}}
							/>
						</If>
					</Buttons>
					<If when={here() && s()?.reports && !s()?.reports?.complete}>
						<Caption tone="faint">{`This page shows ${s()?.reports?.items.length} of ${s()?.reports?.total} saved reports. Use Previous or Next for more.`}</Caption>
					</If>
				</Block>
				<If when={here() && s()?.reports && !visible().length}>
					<EmptyLine text="No reports match these filters. Show tackled or hidden labels to include more." />
				</If>
			</PanelSlice>
		</View>
	);
	return (
		<List
			testID="slack-report-list"
			each={rows()}
			keyExtractor={(r) => r.id}
			estimatedItemSize={72}
			class="min-h-0 flex-1"
			header={head}
			footer={<PanelSlice part="foot" />}
			{...keepScroll("slack")}
		>
			{(row) => (
				<PanelSlice part="item">
					<If
						when={row().item}
						else={
							<Section
								title={row().title}
								action={
									<If when={row().group}>
										<Link
											label="Edit group…"
											disabled={locked() || !!slackGroupEdit()}
											onPress={() =>
												slackGroupEdit.set({
													projectId: s()!.projectId,
													binding: s()!.binding,
													digest: s()!.reports!.digest,
													offset: s()!.reports!.offset ?? 0,
													caseId: row().group,
													action: "rename",
													name: row().title,
													targetId: "",
													itemIds: [],
												})
											}
										/>
									</If>
								}
							>
								<If when={slackGroupEdit()?.caseId === row().group}>
									<GroupEditor controls={c} locked={locked()} />
								</If>
							</Section>
						}
					>
						<Report item={row().item!} day={props.day} controls={c} locked={locked()} />
					</If>
				</PanelSlice>
			)}
		</List>
	);
}
