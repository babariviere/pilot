import { effect, Keyboard, keymap, Scroll, signal, Text, untracked, View } from "nsh";
import { keepField } from "./kept";
import { type ScheduleControls, type ScheduleRow, submittedScheduleDraft } from "./scheduleControls";
import { type ScheduleDraft, scheduleDraft, schedulesOpen } from "./scheduleDraft";
import { Action, Page, PageTitle, Picker, SectionTitle, TextField } from "./ui";

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
	return (
		<Scroll class="flex-1 bg-background">
			<Page testID="schedules" gap={8}>
				<View class="flex-row items-center gap-3">
					<View class="flex-1">
						<PageTitle
							title={scheduleDraft() ? (scheduleDraft()?.id ? "Edit schedule" : "New schedule") : "Schedules"}
						/>
					</View>
					<Action
						label="Read again"
						disabled={c.busy()}
						onPress={() => void c.read()}
						testID="schedules-refresh"
					/>
					<If when={!scheduleDraft()}>
						<Action label="New schedule…" disabled={!fresh()} onPress={() => edit()} testID="schedule-new" />
					</If>
				</View>
				<If when={c.message()}>
					<Text testID="schedule-message" class="text-sm text-muted-foreground">
						{c.message()}
					</Text>
				</If>
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
						<View class="gap-2">
							<Text class="text-sm text-foreground">
								{o().pending
									? "Schedule change unconfirmed. Saving is held."
									: o().state === "accepted"
										? "Request saved. This draft will not be sent again."
										: `Request status: ${o().state}. Nothing is resent.`}
							</Text>
							<Action
								label="Check status"
								disabled={c.busy()}
								onPress={() => void c.check(o().operationId)}
								testID="schedule-check"
							/>
						</View>
					)}
				</Each>
				<If
					when={s()}
					else={
						<Text class="text-sm text-muted-foreground">
							Schedules are unavailable. This is not an empty list.
						</Text>
					}
				>
					<If when={s()?.enabled === false || s()?.paused}>
						<View class="gap-1 rounded-lg bg-muted p-4">
							<Text class="text-sm font-medium text-foreground">
								{s()?.enabled === false ? "Automation is off" : "Scheduled starts are held"}
							</Text>
							<Text class="text-sm text-muted-foreground">
								No scheduled work will start. Valid overdue check-ins are combined when work resumes. Expired
								ones will not run.
							</Text>
						</View>
					</If>
					<If
						when={scheduleDraft()}
						else={
							<View class="gap-6">
								<If when={s()?.schedules.length === 0}>
									<Text class="text-sm text-muted-foreground">
										No schedules on this page. Create one to send work to an existing agent at a chosen time.
									</Text>
								</If>
								<View>
									<Each of={s()?.schedules ?? []} key={(r) => r.id}>
										{(r) => (
											<View class="gap-2 border-t border-border py-4">
												<View class="flex-row items-center gap-2">
													<Text class="flex-1 text-base font-medium text-foreground">{r().title}</Text>
													<Action
														label={expanded() === r().id ? "Hide details" : "Details"}
														onPress={() => expanded.set(expanded() === r().id ? "" : r().id)}
														testID={`schedule-details-${r().id}`}
													/>
												</View>
												<Text class="text-sm text-muted-foreground">{`${s()?.projects.find((p) => p.id === r().projectId)?.name ?? "Earlier project"} · ${describe(r())}`}</Text>
												<Text testID={`schedule-state-${r().id}`} class="text-sm text-foreground">
													{r().error ??
														r().notice?.error ??
														(r().state === "pending"
															? r().paused
																? "Paused"
																: r().held
																	? "Held"
																	: `Next: ${r().atLocal.replace("T", " ")}`
															: r().state === "dispatching"
																? "Starting. Delivery may be uncertain."
																: r().state === "fired"
																	? r().runs?.some((run) => run.admittedAt !== undefined)
																		? "Input acknowledged"
																		: "Request saved for delivery"
																	: r().state)}
												</Text>
												<If when={r().expiresLocal}>
													<Text class="text-xs text-muted-foreground">{`Valid until ${r().expiresLocal.replace("T", " ")} ${r().timeZone ?? "UTC"}`}</Text>
												</If>
												<If when={expanded() === r().id}>
													<View class="gap-3">
														<View selectable>
															<Text class="text-sm text-muted-foreground">{`Target: ${s()?.targets.find((t) => t.id === r().target.sessionId)?.title ?? r().target.sessionId ?? "New agent"}`}</Text>
															<Text class="text-sm text-foreground">
																{r().target.message ?? r().target.spawn?.message ?? ""}
															</Text>
														</View>
														<Each of={r().runs ?? []} key={(run) => String(run.due)}>
															{(run) => (
																<Text class="text-sm text-muted-foreground">{`${new Date(run().admittedAt ?? run().at).toISOString()} · ${run().admittedAt !== undefined ? "Input acknowledged" : runOutcome(run().outcome)}${run().late ? " · Requested late" : ""}${run().count ? ` · ${run().count} occurrences handled` : ""}${run().error ? ` · ${run().error}` : ""}`}</Text>
															)}
														</Each>
														<If when={r().state === "pending" && !r().insightsEnableOperationId}>
															<View class="flex-row gap-2">
																<Action
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
																	<Action
																		label="Edit…"
																		disabled={!fresh()}
																		onPress={() => edit(r())}
																	/>
																</If>
																<Action
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
															</View>
														</If>
														<If when={r().insightsEnableOperationId}>
															<Text class="text-xs text-muted-foreground">
																Managed in Insights settings.
															</Text>
														</If>
													</View>
												</If>
											</View>
										)}
									</Each>
								</View>
								<SectionTitle title="Checks and repair" />
								<Text class="text-sm text-muted-foreground">
									At most three follow-ups per user-directed run. Repairs stop sooner on no progress, a hold,
									or exhausted allowance.
								</Text>
								<Each of={s()?.history.items ?? []} key={(h) => h.sessionId}>
									{(h) => (
										<View class="gap-2 border-t border-border py-3">
											<Text class="text-sm font-medium text-foreground">{h().title}</Text>
											<Text class="text-sm text-muted-foreground">{`${h().attempts} of 3 repair follow-ups used${h().stopped ? " · Stopped" : ""}`}</Text>
											<If when={h().attention}>
												<Text class="text-sm text-foreground">{h().attention}</Text>
											</If>
											<Each of={h().runs ?? []} key="index">
												{(r) => (
													<View selectable>
														<Text class="text-sm text-muted-foreground">{`${r().name}: ${r().state}`}</Text>
														<Text class="text-xs text-muted-foreground">{r().excerpt}</Text>
													</View>
												)}
											</Each>
											<If when={h().flow || h().invalidFlow}>
												<View class="gap-2">
													<Text class="text-sm font-medium text-foreground">{`Earlier flow: ${flowState(h().flowAccounting?.state)}`}</Text>
													<Text class="text-sm text-muted-foreground">{`${h().flowAccounting?.unfinishedVisits ?? "Unknown number of"} visits without a saved outcome. Unknown is not completion or permission to replay.`}</Text>
													<Text class="text-xs text-muted-foreground">
														Existing flows keep their owner and controls. Reading here never starts,
														resumes or transfers a flow.
													</Text>
													<Action
														label={
															expanded() === `flow/${h().sessionId}`
																? "Hide definition and history"
																: "Read definition and history"
														}
														onPress={() =>
															expanded.set(
																expanded() === `flow/${h().sessionId}` ? "" : `flow/${h().sessionId}`,
															)
														}
													/>
													<If when={expanded() === `flow/${h().sessionId}`}>
														<View selectable>
															<Text class="text-xs text-muted-foreground">
																{h().invalidFlow
																	? "Saved flow data could not be decoded. Original history is preserved."
																	: JSON.stringify(h().flow, null, 2)}
															</Text>
														</View>
													</If>
												</View>
											</If>
										</View>
									)}
								</Each>
								<View class="flex-row gap-2">
									<Action
										label="Previous page"
										disabled={c.busy() || (s()?.page ?? 0) === 0}
										onPress={() => void c.read((s()?.page ?? 1) - 1)}
									/>
									<Text class="text-xs text-muted-foreground">{`Page ${(s()?.page ?? 0) + 1}`}</Text>
									<Action
										label="Next page"
										disabled={
											c.busy() || !(s()?.more || s()?.history.more || s()?.targetsMore || s()?.projectsMore)
										}
										onPress={() => void c.read((s()?.page ?? 0) + 1)}
									/>
								</View>
							</View>
						}
					>
						<ScheduleEditor controls={c} />
					</If>
				</If>
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
			<View class="gap-1.5">
				<Text class="text-sm text-foreground">{label}</Text>
				<TextField
					readonly={c.busy() || c.blocked() || c.operations().some((o) => o.pending)}
					ref={field.ref}
					accessibilityLabel={label}
					value={String(d()[key])}
					placeholder={placeholder}
					testID={`schedule-${key}`}
					onFocus={field.focus}
					onSelectionChange={field.select}
					onChange={({ value }) => change(key, value)}
				/>
			</View>
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
		<View class="gap-4">
			<If when={!d().draftId}>
				<Text class="text-sm text-muted-foreground">
					This kept draft has no request identity. Its text is kept, but it cannot be submitted. Close it and
					choose New schedule to make a new request.
				</Text>
			</If>
			<If when={submittedScheduleDraft(c.operations(), d().draftId)}>
				<Text class="text-sm text-muted-foreground">
					This draft has a saved or replacement request. Check its status; it will not be saved again. Close it to
					prepare a new change.
				</Text>
			</If>
			<If
				when={
					!!d().draftId &&
					(d().binding !== s()?.binding || d().draftId !== s()?.draftId) &&
					!submittedScheduleDraft(c.operations(), d().draftId)
				}
			>
				<View class="gap-2">
					<Text class="text-sm text-foreground">
						Review the current state before saving this kept draft. If its schedule changed, cancel and edit the
						latest version.
					</Text>
					<Action
						label="Prepare new save"
						disabled={
							!s()?.binding ||
							(!!d().id && !s()?.schedules.some((r) => r.id === d().id && r.revision === d().revision))
						}
						onPress={() =>
							scheduleDraft.set({ ...d(), binding: s()?.binding ?? "", draftId: s()?.draftId ?? "" })
						}
					/>
				</View>
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
			<View class="flex-row gap-2">
				<Action
					label="Previous choices"
					disabled={c.busy() || (s()?.page ?? 0) === 0}
					onPress={() => void c.read((s()?.page ?? 1) - 1)}
				/>
				<Action
					label="More choices"
					disabled={c.busy() || !(s()?.targetsMore || s()?.projectsMore)}
					onPress={() => void c.read((s()?.page ?? 0) + 1)}
				/>
			</View>
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
					<View class="gap-4">
						{patch("Time (HH:MM)", "time")}
						<If when={d().repeat === "week"}>{patch("Weekday (Monday 1 to Sunday 7)", "weekday")}</If>
						<If when={d().repeat === "month"}>{patch("Day of month (1 to 31)", "day")}</If>
						<Text class="text-xs text-muted-foreground">
							Catch-up uses only the latest relevant occurrence. Overlap is skipped without changing the next
							scheduled time.
						</Text>
					</View>
				}
			>
				{patch("Date and time (YYYY-MM-DDTHH:MM)", "at", "2026-11-18T10:00")}
				{patch("Expiry, optional (YYYY-MM-DDTHH:MM)", "expires")}
				<Text class="text-xs text-muted-foreground">
					Late work runs only while valid. Nothing starts at or after expiry. To remove a saved expiry, cancel this
					schedule and create a replacement.
				</Text>
			</If>
			{patch("Time zone", "zone", "Europe/Paris")}
			<Text class="text-xs text-muted-foreground">
				Times use this zone. For a repeated clock hour, use the first occurrence; a skipped time moves to the first
				valid minute.
			</Text>
			<View class="flex-row gap-2">
				<Action
					variant="primary"
					label="Save schedule"
					testID="schedule-save"
					disabled={!allowed()}
					onPress={() => void save()}
				/>
				<Action
					label="Cancel"
					testID="schedule-editor-cancel"
					onPress={() => {
						Keyboard.dismiss();
						scheduleDraft.set(null);
					}}
				/>
			</View>
		</View>
	);
}
