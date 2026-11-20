import { effect, Keyboard, keymap, Scroll, signal, untracked, View } from "nsh";
import { keepField } from "../../app/kept";
import {
	Block,
	Body,
	BodyStrong,
	Button,
	Buttons,
	Caption,
	Column,
	EmptyLine,
	Field,
	Link,
	Notice,
	Num,
	Page,
	PageHead,
	Panel,
	Picker,
	Quote,
	Row,
	RowDetail,
	Rows,
	Section,
} from "../../ui";
import { type ScheduleControls, type ScheduleRow, submittedScheduleDraft } from "./scheduleControls";
import { type ScheduleDraft, scheduleDraft, schedulesOpen } from "./scheduleDraft";

function flowState(state?: string): string {
	return (
		(
			{
				completed: "Finished",
				failed: "Failed",
				cancelled: "Cancelled",
				held: "Held",
				working: "Working",
				interrupted: "Interrupted",
				waiting_for_existing_owner: "Waiting for its existing owner",
				unknown: "Unknown",
			} as Record<string, string>
		)[state ?? "unknown"] ?? "Unknown"
	);
}

function describe(row: ScheduleRow): string {
	const r = row.recurrence;
	if (!r) return `Once: ${row.atLocal.replace("T", " ")} ${row.timeZone ?? "UTC"}`;
	const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	return `${r.every === "day" ? (r.weekdays?.length ? r.weekdays.map((d) => days[d % 7]).join(", ") : "Daily") : r.every === "week" ? `Weekly, ${r.weekday === undefined ? "Unknown weekday" : days[r.weekday % 7]}` : `Monthly, day ${r.dayOfMonth}`} at ${r.time} ${r.timeZone}`;
}
function runOutcome(outcome: string): string {
	return (
		(
			{
				sent: "Follow-up saved for delivery",
				started: "Agent created",
				skipped_running: "Skipped: previous work still running",
				unknown: "Admission unknown",
				missed: "Missed",
				failed: "Failed",
			} as Record<string, string>
		)[outcome] ?? outcome
	);
}
function close() {
	Keyboard.dismiss();
	schedulesOpen.set(false);
}
export function SchedulesScreen(props: { controls: ScheduleControls }) {
	const c = props.controls,
		s = c.snapshot;
	const expanded = scheduleExpanded;
	effect(() => {
		untracked(() => void c.read());
	});
	keymap.bind(
		"escape",
		() => {
			if (scheduleDraft()) {
				Keyboard.dismiss();
				scheduleDraft.set(null);
			} else close();
		},
		{ when: "always" },
	);
	const fresh = () => !!s()?.binding && !c.busy() && !c.operations().some((o) => o.pending);
	function edit(row?: ScheduleRow) {
		c.begin();
		const now = s();
		if (!now || !fresh()) return;
		const target = now.targets.find((t) => t.id === row?.target.sessionId);
		const r = row?.recurrence;
		scheduleDraft.set({
			draftId: now.draftId,
			binding: now.binding,
			id: row?.id ?? "",
			revision: row?.revision ?? 0,
			project: target?.projectId ?? "",
			target: target?.id ?? "",
			title: row?.title ?? "",
			message: row?.target.message ?? "",
			repeat: r?.every ?? "once",
			at: row?.atLocal ?? "",
			expires: row?.expiresLocal ?? "",
			zone: r?.timeZone ?? row?.timeZone ?? "UTC",
			time: r?.time ?? "09:00",
			weekday: String(r?.weekday ?? 1),
			day: String(r?.dayOfMonth ?? 1),
		});
	}
	/** What a schedule is doing now, in words. */
	const stateLine = (r: ScheduleRow) =>
		r.error ??
		r.notice?.error ??
		(r.state === "pending"
			? r.paused
				? "Paused"
				: r.held
					? "Held"
					: `Next: ${r.atLocal.replace("T", " ")}`
			: r.state === "dispatching"
				? "Starting. Delivery may be uncertain."
				: r.state === "fired"
					? r.runs?.some((run) => run.admittedAt !== undefined)
						? "Input acknowledged"
						: "Request saved for delivery"
					: r.state);
	return (
		<Scroll class="flex-1">
			<Page testID="schedules">
				<PageHead
					title={scheduleDraft() ? (scheduleDraft()?.id ? "Edit schedule" : "New schedule") : "Schedules"}
					actions={
						<>
							<Button
								label="Read again"
								disabled={c.busy()}
								onPress={() => void c.read()}
								testID="schedules-refresh"
							/>
							<If when={!scheduleDraft()}>
								<Button
									label="New schedule…"
									disabled={!fresh()}
									onPress={() => edit()}
									testID="schedule-new"
								/>
							</If>
						</>
					}
				>
					<If when={c.message()}>
						<Body testID="schedule-message" tone="muted">
							{c.message()}
						</Body>
					</If>
				</PageHead>
				<Panel
					notice={
						<If when={s()?.enabled === false || s()?.paused}>
							<Notice
								placement="panel"
								text={s()?.enabled === false ? "Automation is off" : "Scheduled starts are held"}
								detail="No scheduled work will start. Valid overdue check-ins are combined when work resumes. Expired ones will not run."
							/>
						</If>
					}
				>
					<Column>
						<Each
							of={c
								.operations()
								.filter(
									(o) =>
										o.pending ||
										(!!scheduleDraft()?.draftId && submittedScheduleDraft([o], scheduleDraft()!.draftId)),
								)}
							key={(o) => o.operationId}
						>
							{(o) => (
								<Notice
									placement="section"
									text={
										o().pending
											? "Schedule change unconfirmed. Saving is held."
											: o().state === "accepted"
												? "Request saved. This draft will not be sent again."
												: `Request status: ${o().state}. Nothing is resent.`
									}
									action={
										<Button
											small
											label="Check status"
											disabled={c.busy()}
											onPress={() => void c.check(o().operationId)}
											testID="schedule-check"
										/>
									}
								/>
							)}
						</Each>
						<If
							when={s()}
							else={
								<Section title="Schedules">
									<EmptyLine text="Schedules are unavailable. This is not an empty list." />
								</Section>
							}
						>
							<If
								when={scheduleDraft()}
								else={
									<>
										<Section title="Schedules" count={s()?.schedules.length}>
											<If when={s()?.schedules.length === 0}>
												<EmptyLine text="No schedules on this page. Create one to send work to an existing agent at a chosen time." />
											</If>
											<Rows>
												<Each of={s()?.schedules ?? []} key={(r) => r.id}>
													{(r) => (
														<Row
															title={r().title}
															meta={`${s()?.projects.find((p) => p.id === r().projectId)?.name ?? "Earlier project"} · ${describe(r())}`}
															trailing={
																<Button
																	small
																	label={expanded() === r().id ? "Hide details" : "Details"}
																	onPress={() => expanded.set(expanded() === r().id ? "" : r().id)}
																	testID={`schedule-details-${r().id}`}
																/>
															}
															detail={
																<RowDetail>
																	<Body testID={`schedule-state-${r().id}`}>{stateLine(r())}</Body>
																	<If when={r().expiresLocal}>
																		<Caption>{`Valid until ${r().expiresLocal.replace("T", " ")} ${r().timeZone ?? "UTC"}`}</Caption>
																	</If>
																	<If when={expanded() === r().id}>
																		<View selectable>
																			<Caption>{`Target: ${s()?.targets.find((t) => t.id === r().target.sessionId)?.title ?? r().target.sessionId ?? "New agent"}`}</Caption>
																			<Body>
																				{r().target.message ?? r().target.spawn?.message ?? ""}
																			</Body>
																		</View>
																		<Each of={r().runs ?? []} key={(run) => String(run.due)}>
																			{(run) => (
																				<Caption>{`${new Date(run().admittedAt ?? run().at).toISOString()} · ${run().admittedAt !== undefined ? "Input acknowledged" : runOutcome(run().outcome)}${run().late ? " · Requested late" : ""}${run().count ? ` · ${run().count} occurrences handled` : ""}${run().error ? ` · ${run().error}` : ""}`}</Caption>
																			)}
																		</Each>
																		<If
																			when={
																				r().state === "pending" && !r().insightsEnableOperationId
																			}
																		>
																			<Buttons>
																				<Button
																					small
																					label={r().paused ? "Resume" : "Pause"}
																					disabled={!fresh()}
																					onPress={() =>
																						void c.write(
																							"update",
																							{
																								id: r().id,
																								expectedRevision: r().revision,
																								paused: !r().paused,
																							},
																							s()?.binding ?? "",
																						)
																					}
																					testID={`schedule-pause-${r().id}`}
																				/>
																				<If when={r().target.kind === "message"}>
																					<Button
																						small
																						label="Edit…"
																						disabled={!fresh()}
																						onPress={() => edit(r())}
																					/>
																				</If>
																				<Button
																					small
																					label="Cancel schedule"
																					disabled={!fresh()}
																					onPress={() =>
																						void c.write(
																							"cancel",
																							{ id: r().id, expectedRevision: r().revision },
																							s()?.binding ?? "",
																						)
																					}
																					testID={`schedule-cancel-${r().id}`}
																				/>
																			</Buttons>
																		</If>
																		<If when={r().insightsEnableOperationId}>
																			<Caption>Managed in Insights settings.</Caption>
																		</If>
																	</If>
																</RowDetail>
															}
														/>
													)}
												</Each>
											</Rows>
										</Section>
										<Section title="Checks and repair">
											<Block>
												<Caption>
													At most three follow-ups per user-directed run. Repairs stop sooner on no
													progress, a hold, or exhausted allowance.
												</Caption>
											</Block>
											<Rows>
												<Each of={s()?.history.items ?? []} key={(h) => h.sessionId}>
													{(h) => (
														<Row
															title={h().title}
															meta={`${h().attempts} of 3 repair follow-ups used${h().stopped ? " · Stopped" : ""}`}
															detail={
																<RowDetail>
																	<If when={h().attention}>
																		<Body>{h().attention}</Body>
																	</If>
																	<Each of={h().runs ?? []} key="index">
																		{(r) => (
																			<View selectable>
																				<Body tone="muted">{`${r().name}: ${r().state}`}</Body>
																				<Caption>{r().excerpt}</Caption>
																			</View>
																		)}
																	</Each>
																	<If when={h().flow || h().invalidFlow}>
																		<BodyStrong>{`Earlier flow: ${flowState(h().flowAccounting?.state)}`}</BodyStrong>
																		<Body tone="muted">{`${h().flowAccounting?.unfinishedVisits ?? "Unknown number of"} visits without a saved outcome. Unknown is not completion or permission to replay.`}</Body>
																		<Caption>
																			Existing flows keep their owner and controls. Reading here
																			never starts, resumes or transfers a flow.
																		</Caption>
																		<View class="flex-row">
																			<Link
																				label={
																					expanded() === `flow/${h().sessionId}`
																						? "Hide definition and history"
																						: "Read definition and history"
																				}
																				onPress={() =>
																					expanded.set(
																						expanded() === `flow/${h().sessionId}`
																							? ""
																							: `flow/${h().sessionId}`,
																					)
																				}
																			/>
																		</View>
																		<If when={expanded() === `flow/${h().sessionId}`}>
																			<Quote
																				code={!h().invalidFlow}
																				text={
																					h().invalidFlow
																						? "Saved flow data could not be decoded. Original history is preserved."
																						: JSON.stringify(h().flow, null, 2)
																				}
																			/>
																		</If>
																	</If>
																</RowDetail>
															}
														/>
													)}
												</Each>
											</Rows>
											<Block>
												<Buttons>
													<Button
														small
														label="Previous page"
														disabled={c.busy() || (s()?.page ?? 0) === 0}
														onPress={() => void c.read((s()?.page ?? 1) - 1)}
													/>
													<Num>{`Page ${(s()?.page ?? 0) + 1}`}</Num>
													<Button
														small
														label="Next page"
														disabled={
															c.busy() ||
															!(s()?.more || s()?.history.more || s()?.targetsMore || s()?.projectsMore)
														}
														onPress={() => void c.read((s()?.page ?? 0) + 1)}
													/>
												</Buttons>
											</Block>
										</Section>
									</>
								}
							>
								<Section title="Schedule">
									<ScheduleEditor controls={c} />
								</Section>
							</If>
						</If>
					</Column>
				</Panel>
			</Page>
		</Scroll>
	);
}
const scheduleExpanded = signal("");
function ScheduleEditor(props: { controls: ScheduleControls }) {
	const c = props.controls,
		d = () => scheduleDraft()!,
		s = c.snapshot;
	const change = (key: keyof ScheduleDraft, value: string) => scheduleDraft.set({ ...d(), [key]: value });
	const patch = (label: string, key: keyof ScheduleDraft, placeholder?: string) => {
		const field = keepField(
			`schedule-${key}`,
			() => "settings",
			() => String(d()?.[key] ?? ""),
		);
		return (
			<Field
				label={label}
				readonly={c.busy() || c.blocked() || c.operations().some((o) => o.pending)}
				anchor={field.ref}
				value={String(d()[key])}
				placeholder={placeholder}
				testID={`schedule-${key}`}
				onFocus={field.focus}
				onSelectionChange={field.select}
				onChange={(value) => change(key, value)}
			/>
		);
	};
	const allowed = () =>
		!!s()?.binding &&
		!!d().draftId &&
		d().draftId === s()?.draftId &&
		!submittedScheduleDraft(c.operations(), d().draftId) &&
		!c.blocked() &&
		d().binding === s()?.binding &&
		!c.busy() &&
		!c.operations().some((o) => o.pending) &&
		!!d().project &&
		!!d().target &&
		!!d().message.trim() &&
		!!d().title.trim() &&
		(d().repeat !== "once" || !!d().at);
	async function save() {
		if (!allowed()) return;
		const before = d();
		const previous = s()?.schedules.find((r) => r.id === before.id && r.revision === before.revision);
		const value = {
			title: before.title,
			target: { kind: "message", sessionId: before.target, message: before.message },
			...(before.repeat === "once"
				? { trigger: "at", atLocal: before.at, expiresLocal: before.expires, timeZone: before.zone }
				: {
						trigger: "recurring",
						recurrence: {
							every: before.repeat,
							time: before.time,
							timeZone: before.zone,
							...(before.repeat === "day" &&
							previous?.recurrence?.every === "day" &&
							previous.recurrence.weekdays
								? { weekdays: previous.recurrence.weekdays }
								: {}),
							...(before.repeat === "week"
								? { weekday: Number(before.weekday) }
								: before.repeat === "month"
									? { dayOfMonth: Number(before.day) }
									: {}),
						},
					}),
			...(before.id ? { id: before.id, expectedRevision: before.revision } : {}),
		};
		if (await c.write(before.id ? "update" : "create", value, before.binding, before.draftId)) {
			Keyboard.dismiss();
			scheduleDraft.set(null);
		}
	}
	return (
		<Block gap={4}>
			<If when={!d().draftId}>
				<Body tone="muted">
					This kept draft has no request identity. Its text is kept, but it cannot be submitted. Close it and
					choose New schedule to make a new request.
				</Body>
			</If>
			<If when={submittedScheduleDraft(c.operations(), d().draftId)}>
				<Body tone="muted">
					This draft has a saved or replacement request. Check its status; it will not be saved again. Close it to
					prepare a new change.
				</Body>
			</If>
			<If
				when={
					!!d().draftId &&
					(d().binding !== s()?.binding || d().draftId !== s()?.draftId) &&
					!submittedScheduleDraft(c.operations(), d().draftId)
				}
			>
				<Notice
					placement="section"
					text="Review the current state before saving this kept draft. If its schedule changed, cancel and edit the latest version."
					action={
						<Button
							small
							label="Prepare new save"
							disabled={
								!s()?.binding ||
								(!!d().id && !s()?.schedules.some((r) => r.id === d().id && r.revision === d().revision))
							}
							onPress={() =>
								scheduleDraft.set({ ...d(), binding: s()?.binding ?? "", draftId: s()?.draftId ?? "" })
							}
						/>
					}
				/>
			</If>
			{patch("Title", "title")}
			<Picker
				label="Project"
				placeholder={d().project ? `Selected project: ${d().project}` : "Choose a project"}
				testID="schedule-project"
				items={(s()?.projects ?? []).map((p) => ({ value: p.id, title: p.name }))}
				value={d().project || null}
				disabled={!!d().id || c.busy() || c.blocked()}
				onChange={(project) => scheduleDraft.set({ ...d(), project, target: "" })}
			/>
			<Picker
				label="Target agent"
				disabled={c.busy() || c.blocked()}
				placeholder="Choose an existing agent"
				testID="schedule-target"
				items={(s()?.targets ?? [])
					.filter((t) => t.projectId === d().project)
					.map((t) => ({ value: t.id, title: t.title }))}
				value={d().target || null}
				onChange={(target) => change("target", target)}
			/>
			<Buttons>
				<Button
					small
					label="Previous choices"
					disabled={c.busy() || (s()?.page ?? 0) === 0}
					onPress={() => void c.read((s()?.page ?? 1) - 1)}
				/>
				<Button
					small
					label="More choices"
					disabled={c.busy() || !(s()?.targetsMore || s()?.projectsMore)}
					onPress={() => void c.read((s()?.page ?? 0) + 1)}
				/>
			</Buttons>
			{patch("Message", "message")}
			<Picker
				label="Repeat"
				placeholder="Choose repeat"
				testID="schedule-repeat"
				items={[
					{ value: "once", title: "Once" },
					{ value: "day", title: "Daily" },
					{ value: "week", title: "Weekly" },
					{ value: "month", title: "Monthly" },
				]}
				value={d().repeat}
				disabled={!!d().id || c.busy() || c.blocked()}
				onChange={(v) => change("repeat", v)}
			/>
			<If
				when={d().repeat === "once"}
				else={
					<>
						{patch("Time (HH:MM)", "time")}
						<If when={d().repeat === "week"}>{patch("Weekday (Monday 1 to Sunday 7)", "weekday")}</If>
						<If when={d().repeat === "month"}>{patch("Day of month (1 to 31)", "day")}</If>
						<Caption>
							Catch-up uses only the latest relevant occurrence. Overlap is skipped without changing the next
							scheduled time.
						</Caption>
					</>
				}
			>
				{patch("Date and time (YYYY-MM-DDTHH:MM)", "at", "2026-11-18T10:00")}
				{patch("Expiry, optional (YYYY-MM-DDTHH:MM)", "expires")}
				<Caption>
					Late work runs only while valid. Nothing starts at or after expiry. To remove a saved expiry, cancel this
					schedule and create a replacement.
				</Caption>
			</If>
			{patch("Time zone", "zone", "Europe/Paris")}
			<Caption>
				Times use this zone. For a repeated clock hour, use the first occurrence; a skipped time moves to the first
				valid minute.
			</Caption>
			<Buttons>
				<Button
					kind="primary"
					label="Save schedule"
					testID="schedule-save"
					disabled={!allowed()}
					onPress={() => void save()}
				/>
				<Button
					label="Cancel"
					testID="schedule-editor-cancel"
					onPress={() => {
						Keyboard.dismiss();
						scheduleDraft.set(null);
					}}
				/>
			</Buttons>
		</Block>
	);
}
