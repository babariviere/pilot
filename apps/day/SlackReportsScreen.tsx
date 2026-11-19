import { effect, Keyboard, keymap, List, signal, Text, View } from "nsh";
import type { Day } from "./day";
import { openChat } from "./chatView";
import { IntakeWorkControls } from "./Incoming";
import { keepScroll } from "./kept";
import { openMission } from "./view";
import type { ReportDetails, ReportEvidence, SlackControls, SlackReport } from "./slackControls";
import { closeSlack, selectedSlackReport, slackEdit, slackGroupEdit, slackProject, slackOffset } from "./slackView";
import { Action, CheckboxRow, ExpandableRow, Field, Notice, PageTitle, Picker, ReadField } from "./ui";

const EMPTY: ReportDetails = { client: null, reporter: null, issue: null };
const NAMES = { client: "Client organization", reporter: "Original reporter", issue: "Issue" };
const KEYS = ["client", "reporter", "issue"] as const;
type Row = { id: string; group: string; title: string; item?: SlackReport };
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
		<View class="gap-4 border-t border-border pt-4">
			<Text class="text-sm font-medium text-foreground">Correct report details</Text>
			<Text class="text-xs text-muted-foreground">
				Leave both fields empty for Not identified. A named original reporter needs source evidence, not the Slack
				author's name.
			</Text>
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
				<Text class="text-sm text-needs-ink">
					Reports changed. Your draft is kept. Cancel and correct the current report.
				</Text>
			</If>
			<View class="flex-row gap-2">
				<Action
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
				<Action
					label="Cancel"
					onPress={() => {
						Keyboard.dismiss();
						slackEdit.set(null);
					}}
				/>
			</View>
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
		<View class="gap-3 border-t border-border pt-4">
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
						<CheckboxRow
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
				<Text class="text-sm text-needs-ink">
					Reports changed. Your draft is kept. Cancel and edit the current group.
				</Text>
			</If>
			<View class="flex-row gap-2">
				<Action
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
				<Action
					label="Cancel"
					onPress={() => {
						Keyboard.dismiss();
						slackGroupEdit.set(null);
					}}
				/>
			</View>
		</View>
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
		<ExpandableRow
			testID={`slack-report-${i().id}`}
			open={selectedSlackReport() === i().id}
			onToggle={() => selectedSlackReport.set(selectedSlackReport() === i().id ? null : i().id)}
			accessibilityLabel={`${i().title}, ${status(i())}. Show report details.`}
			summaryClass="gap-1 py-3"
			content={
				<View class="gap-4 pb-5">
					<View class="flex-row items-center gap-2">
						<Text class="flex-1 text-sm font-medium text-foreground">Report details</Text>
						<Action
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
					</View>
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
						<Text class="text-xs text-faint">{i().url}</Text>
					</View>
					<If when={props.controls.open && s().canOpenUrl !== false}>
						<Action
							label="Source message"
							disabled={props.locked}
							onPress={() => void props.controls.open?.(i().id, s().reports!.digest, s().binding)}
						/>
					</If>
					<If when={slackEdit()?.itemId === i().id}>
						<Corrections controls={props.controls} locked={props.locked} />
					</If>
					<View class="flex-row flex-wrap items-center gap-3">
						<Text class="text-xs text-muted-foreground">{`Label: ${i().slack?.label ?? "None"} · ${i().slack?.severity ?? "Not identified"} severity`}</Text>
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
					</View>
					<Text class="text-xs text-faint">Labels organize or hide reports. They never mark tackled.</Text>
					<View class="flex-row flex-wrap gap-2">
						<If when={i().sessionId && props.day.chat}>
							<Action label="View linked work" onPress={() => openChat(i().sessionId!, "Slack reports")} />
						</If>
						<If when={i().missionId}>
							<Action
								label="View linked mission"
								onPress={() => {
									closeSlack();
									openMission(i().missionId!);
								}}
							/>
						</If>
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
										<Action
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
						<Action
							label={i().slack?.status === "done" ? "Mark open" : "Mark tackled"}
							testID={`slack-tackle-${i().id}`}
							disabled={props.locked}
							onPress={() => void mutate({ status: i().slack?.status === "done" ? "open" : "done" })}
						/>
					</View>
					<Each
						of={
							intake()
								?.view()
								.unsettled.filter((o) => o.itemId === i().id) ?? []
						}
						key={(o) => o.operationId}
					>
						{(o) => (
							<Notice text="Starting this work is not confirmed. It will not be started again.">
								<Action
									label="Check start status"
									disabled={o().delivery === "checking"}
									onPress={async () => {
										await intake()?.source.check(o().operationId);
										await props.controls.read();
									}}
								/>
							</Notice>
						)}
					</Each>
					<Text class="text-xs text-faint">
						Starting work does not mark tackled. Only a start reaction is sent to Slack.
					</Text>
				</View>
			}
		>
			<View class="flex-row gap-3">
				<Text class="flex-1 text-sm font-medium text-foreground">{i().title}</Text>
				<Text class="text-xs text-muted-foreground">{status(i())}</Text>
			</View>
			<Text class="text-xs text-faint">{i().metadata.channelName ? `#${i().metadata.channelName}` : "Slack"}</Text>
		</ExpandableRow>
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
	const rows = (): Row[] => {
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
	return (
		<View class="flex-1">
			<View class="w-full max-w-5xl self-center gap-4 px-6 py-6">
				<View class="flex-row items-center gap-3">
					<PageTitle title="Slack reports" class="flex-1" />
					<Action label="Read again" disabled={c.busy()} onPress={() => void c.read()} />
				</View>
				<Text class="text-sm text-muted-foreground">
					{s()?.projectName ?? "Reading saved reports…"} · Coverage is incomplete
				</Text>
				<View class="flex-row flex-wrap gap-2">
					<Action
						label={showTackled() ? "Hide tackled" : "Show tackled"}
						onPress={() => showTackled.set(!showTackled())}
					/>
					<Action
						label={showHidden() ? "Hide labeled reports" : "Show hidden labels"}
						onPress={() => showHidden.set(!showHidden())}
					/>
				</View>
				<If when={c.message()}>
					<Text class="text-sm text-needs-ink">{c.message()}</Text>
				</If>
				<Each of={c.unknown()} key={(o) => o.operationId}>
					{(o) => (
						<Notice text="This Slack action is not confirmed. It will not be sent again.">
							<Action label="Check status" disabled={c.busy()} onPress={() => void c.check(o().operationId)} />
						</Notice>
					)}
				</Each>
				<If when={s() && !here()}>
					<Notice text="These reports belong to another project. Nothing is shown or changed." />
				</If>
				<If when={here() && s()?.reports && !s()?.reports?.complete}>
					<Text class="text-xs text-faint">{`This page shows ${s()?.reports?.items.length} of ${s()?.reports?.total} saved reports. Use Previous or Next for more.`}</Text>
				</If>
				<If when={here() && !s()?.reports}>
					<Notice text="Slack reports are unavailable. Read again; this is not an empty list." />
				</If>
				<If when={here() && s()?.reports && !visible().length}>
					<Text class="text-sm text-muted-foreground">
						No reports match these filters. Show tackled or hidden labels to include more.
					</Text>
				</If>
				<If when={here() && s()?.reports && ((s()?.reports?.offset ?? 0) > 0 || s()?.reports?.more)}>
					<View class="flex-row gap-2">
						<Action
							label="Previous reports"
							disabled={locked() || !s()?.reports?.offset}
							onPress={() => {
								selectedSlackReport.set(null);
								void c.read(Math.max(0, (s()?.reports?.offset ?? 0) - 100));
							}}
						/>
						<Action
							label="Next reports"
							disabled={locked() || !s()?.reports?.more}
							onPress={() => {
								selectedSlackReport.set(null);
								void c.read((s()?.reports?.offset ?? 0) + 100);
							}}
						/>
					</View>
				</If>
			</View>
			<List
				testID="slack-report-list"
				each={rows()}
				keyExtractor={(r) => r.id}
				estimatedItemSize={72}
				class="min-h-0 flex-1"
				{...keepScroll("slack")}
			>
				{(row) => (
					<View class="w-full max-w-5xl self-center px-6">
						<If
							when={row().item}
							else={
								<View class="gap-2 border-b border-border py-4">
									<View class="flex-row items-center gap-3">
										<Text class="flex-1 text-base font-semibold text-foreground">{row().title}</Text>
										<If when={row().group}>
											<Action
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
									</View>
									<If when={slackGroupEdit()?.caseId === row().group}>
										<GroupEditor controls={c} locked={locked()} />
									</If>
								</View>
							}
						>
							<Report item={row().item!} day={props.day} controls={c} locked={locked()} />
						</If>
					</View>
				)}
			</List>
		</View>
	);
}
