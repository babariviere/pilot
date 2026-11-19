import { cleanup, computed, effect, Keyboard, keymap, Scroll, signal, Text, untracked, View } from "nsh";
import {
	closeInsights,
	type InsightsControls,
	type InsightsDetail,
	type InsightsDraft,
	type InsightsIntent,
	type InsightsModel,
	type InsightsSettings,
	type InsightsSnapshot,
	insightsDraft,
	insightsReview,
	insightsSelection,
	insightsTab,
} from "./insightsView";
import {
	Action,
	CheckboxRow,
	Disclosure,
	DividedRow,
	Field,
	MarkdownPreview,
	Notice,
	Page,
	PageTitle,
	Panel,
	Picker,
	SectionTitle,
	TabItem,
	TabRow,
} from "./ui";

type Props = {
	controls: InsightsControls;
	onBack?: () => boolean;
	openChat?: (id: string) => void;
	openWork?: {
		available(): boolean;
		wouldReplace(): boolean;
		draft(kind: "fix" | "plan", detail: InsightsDetail, replace?: boolean): void;
	};
};
const tabs = [
	{ id: "reports", label: "Reports" },
	{ id: "findings", label: "Findings" },
	{ id: "settings", label: "Settings" },
] as const;
const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const usdAmount = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 2,
	maximumFractionDigits: 6,
});
const money = (usd: number) => usdAmount.format(usd);
const labels = {
	off: "Not set up",
	enabled: "Ready",
	paused: "Paused",
	blocked: "Unavailable",
	running: "Report running",
};

function RunScope(props: { settings: InsightsSettings; projects: InsightsSnapshot["projects"] }) {
	const open = signal(false);
	const s = () => props.settings;
	return (
		<View class="gap-1">
			<Meta
				text={`${s().model} • ${s().sourceProjectIds.length} source projects • up to ${money(s().perReportUsd)} per report`}
			/>
			<Disclosure label="What this report may read" open={open()} onToggle={() => open.set(!open())}>
				<Meta
					text={s()
						.sourceProjectIds.map((id) => props.projects.find((p) => p.id === id)?.name ?? id)
						.join(", ")}
				/>
				<Meta text="The selected model provider processes sanitized excerpts. They can still contain private project text." />
				<Meta
					text={
						s().excludeSessionIds.length
							? `Excluded chat IDs: ${s().excludeSessionIds.join(", ")}`
							: "No individual chat exclusions."
					}
				/>
				<Meta
					text={`All active and recently archived chats in these projects are eligible. Monthly limit: ${money(s().monthlyUsd)}.`}
				/>
			</Disclosure>
		</View>
	);
}

function settingDraft(s: InsightsSnapshot): InsightsDraft {
	const p = s.saved ?? s.applied;
	return {
		projectId: p?.projectId ?? "",
		model: p?.model ?? "",
		sourceProjectIds: p?.sourceProjectIds ?? [],
		excludeSessionIds: p?.excludeSessionIds ?? [],
		perReportUsd: p ? String(p.perReportUsd) : "",
		monthlyUsd: p ? String(p.monthlyUsd) : "",
		schedule: p?.schedule ?? null,
		binding: s.draftBinding,
	};
}

function readySettings(d: InsightsDraft | null): InsightsSettings | null {
	if (!d?.projectId || !d.model || !d.sourceProjectIds.length) return null;
	if (![d.perReportUsd, d.monthlyUsd].every((v) => /^\d+(?:\.\d{1,6})?$/.test(v.trim()))) return null;
	const perReportUsd = Number(d.perReportUsd);
	const monthlyUsd = Number(d.monthlyUsd);
	if (!Number.isFinite(perReportUsd) || perReportUsd <= 0 || !Number.isFinite(monthlyUsd) || monthlyUsd <= 0)
		return null;
	if (d.schedule && (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(d.schedule.time) || !d.schedule.timeZone.trim())) return null;
	const { binding: _binding, ...settings } = d;
	return {
		...settings,
		perReportUsd,
		monthlyUsd,
		excludeSessionIds: settings.excludeSessionIds.map((id) => id.trim()).filter(Boolean),
	};
}

function Meta(props: { text: string }) {
	return <Text class="text-sm text-muted-foreground">{props.text}</Text>;
}

function Detail(
	props: Props & {
		detail: InsightsDetail;
		locked: boolean;
		prepare: (i: InsightsIntent) => void;
	},
) {
	const d = () => props.detail;
	const replace = signal<"fix" | "plan" | null>(null);
	function openWork(kind: "fix" | "plan") {
		if (!props.openWork?.available()) return;
		if (props.openWork.wouldReplace()) replace.set(kind);
		else props.openWork.draft(kind, d());
	}
	return (
		<View class="gap-4">
			<View class="gap-1">
				<Text role="header" class="text-xl font-semibold text-foreground">
					{d().title}
				</Text>
				<If when={d().legacy}>
					<Meta text="Earlier Insights. Read-only history." />
				</If>
				<If when={d().lifecycle}>
					<Meta
						text={
							d().lifecycle === "verified"
								? "Benefit verified"
								: ((
										{
											proposed: "Proposed",
											approved: "Approved",
											in_progress: "In progress",
											shipped: "Shipped",
											dismissed: "Dismissed",
											deferred: "Deferred",
										} as Record<string, string>
									)[d().lifecycle ?? ""] ?? "Status unavailable")
						}
					/>
				</If>
			</View>
			<If when={d().markdown || d().proposal}>
				<MarkdownPreview markdown={d().markdown ?? d().proposal ?? ""} />
			</If>
			<If when={d().coverage}>
				<View class="gap-1">
					<SectionTitle title="Partial coverage" />
					<Meta text={d().coverage ?? ""} />
					<If when={d().progress}>
						{(progress) => (
							<Meta
								text={`Sources in this report: ${progress().sources}. Saved positions: ${progress().positionedSources}. Unavailable: ${progress().unavailableSources}.`}
							/>
						)}
					</If>
				</View>
			</If>
			<If when={d().gaps?.length}>
				<View class="gap-1">
					<SectionTitle title="Gaps" />
					<Each of={d().gaps ?? []} key="index">
						{(gap) => <Meta text={gap()} />}
					</Each>
				</View>
			</If>
			<If when={d().evidence?.length}>
				<View class="gap-1">
					<SectionTitle title="Evidence" />
					<Each of={d().evidence ?? []} key="index">
						{(e) => (
							<DividedRow open={false} content={null}>
								<View class="gap-1 py-2">
									<Text class="text-sm font-medium text-foreground">{e().label}</Text>
									<If when={e().position}>
										<Meta text={e().position ?? ""} />
									</If>
									<If when={e().excerpt}>
										<Meta text={e().excerpt ?? ""} />
									</If>
									<If when={props.openChat && e().sessionId}>
										<View class="self-start">
											<Action
												label="Open source chat"
												accessibilityLabel={`Open source chat: ${e().label}`}
												onPress={() => props.openChat?.(e().sessionId)}
											/>
										</View>
									</If>
								</View>
							</DividedRow>
						)}
					</Each>
				</View>
			</If>
			<Each of={d().findingKeys ?? []} key={(key) => key}>
				{(key) => (
					<View class="self-start">
						<Action
							label="Open finding"
							onPress={() => {
								insightsSelection.set({ kind: "findings", key: key() });
								insightsTab.set("findings");
							}}
						/>
					</View>
				)}
			</Each>
			<If when={d().benefit}>
				<View class="gap-1">
					<SectionTitle title="How to check the benefit" />
					<Meta text={d().benefit ?? ""} />
				</View>
			</If>
			<If when={!d().legacy && d().lifecycle}>
				<View class="flex-row flex-wrap items-center gap-2">
					<If when={props.openWork && d().projectId && d().proposal}>
						<Action
							label="Start a fix…"
							variant="primary"
							disabled={props.locked || !props.openWork?.available()}
							onPress={() => openWork("fix")}
						/>
						<Action
							label="Plan a linked mission…"
							disabled={props.locked || !props.openWork?.available()}
							onPress={() => openWork("plan")}
						/>
					</If>
					<If when={d().lifecycle !== "shipped" && d().lifecycle !== "verified"}>
						<Action
							label="Mark shipped…"
							disabled={props.locked}
							onPress={() => props.prepare({ action: "ship", key: d().key, revision: d().revision })}
						/>
					</If>
					<If when={d().lifecycle === "shipped"}>
						<Action
							label="Mark benefit verified…"
							disabled={props.locked}
							onPress={() => props.prepare({ action: "verify", key: d().key, revision: d().revision })}
						/>
					</If>
				</View>
				<If when={props.openWork && !props.openWork.available()}>
					<Meta text="New already has linked work or is starting work. Finish or set that draft aside first." />
				</If>
				<If when={replace()}>
					{(kind) => (
						<Panel class="gap-2">
							<Meta text="Your other New draft stays saved. Opening this finding does not start work." />
							<View class="flex-row flex-wrap gap-2">
								<Action label="Keep existing draft" onPress={() => replace.set(null)} />
								<Action
									label="Open finding draft"
									disabled={props.locked || !props.openWork?.available()}
									onPress={() => props.openWork?.draft(kind(), d(), true)}
								/>
							</View>
						</Panel>
					)}
				</If>
				<If when={d().lifecycle !== "verified"}>
					<Meta text="Shipped does not mean verified. Only you can mark the benefit verified." />
				</If>
			</If>
		</View>
	);
}

function Settings(props: {
	current: InsightsSnapshot;
	controls: InsightsControls;
	locked: boolean;
	prepare(i: InsightsIntent): void;
}) {
	const s = () => props.current;
	const d = () => insightsDraft() ?? settingDraft(s());
	const executionProject = computed(() => d().projectId);
	const models = signal<{ projectId: string; items: InsightsModel[] | null } | null>(null);
	let order = 0;
	effect(() => {
		const projectId = executionProject();
		const request = ++order;
		if (!projectId) return;
		untracked(() => {
			if (models()?.projectId === projectId && models()?.items !== null) return;
			void props.controls.models(projectId).then((items) => {
				if (request === order) models.set({ projectId, items });
			});
		});
	});
	cleanup(() => {
		order++;
	});
	const patch = (changes: Partial<InsightsDraft>) => insightsDraft.set({ ...d(), ...changes });
	const toggle = (id: string) =>
		patch({
			sourceProjectIds: d().sourceProjectIds.includes(id)
				? d().sourceProjectIds.filter((p) => p !== id)
				: [...d().sourceProjectIds, id],
		});
	const updateSchedule = (change: Partial<NonNullable<InsightsSettings["schedule"]>>) => {
		const schedule = d().schedule;
		if (schedule) patch({ schedule: { ...schedule, ...change } });
	};
	const staleDraft = () => d().binding !== s().draftBinding;
	const valid = () => !props.locked && !staleDraft() && !!readySettings(d());
	const prepare = (action: "setup" | "apply" | "save") => {
		const settings = readySettings(d());
		if (valid() && settings) props.prepare({ action, settings });
	};
	return (
		<View class="gap-5">
			<If when={staleDraft()}>
				<Notice text="Settings changed elsewhere. Your draft is kept.">
					<Action label="Use saved settings" onPress={() => insightsDraft.set(null)} />
					<Action label="Keep my draft" onPress={() => patch({ binding: s().draftBinding })} />
				</Notice>
			</If>
			<View class="gap-2">
				<SectionTitle title="Source projects" />
				<Meta text="Insights reads all active chats in these projects, plus chats archived in the past 24 hours. Earlier messages in eligible chats may be read." />
				<Each of={s().projects} key={(p) => p.id}>
					{(p) => (
						<CheckboxRow
							testID={`insights-project-${p().id}`}
							label={p().name}
							checked={d().sourceProjectIds.includes(p().id)}
							onChange={() => toggle(p().id)}
						/>
					)}
				</Each>
				<Field
					label="Excluded chat IDs (comma separated)"
					testID="insights-exclusions"
					value={d().excludeSessionIds.join(",")}
					onChange={(v) => patch({ excludeSessionIds: v.split(",") })}
				/>
			</View>
			<View class="gap-3">
				<SectionTitle title="Model and allowances" />
				<Meta text="The selected model provider receives sanitized excerpts. They can still contain private project text. Reports stop when either allowance cannot cover the next request." />
				<Picker
					label="Report project"
					placeholder="Choose a project"
					value={d().projectId || null}
					disabled={!!(s().saved ?? s().applied)}
					items={s().projects.map((p) => ({ value: p.id, title: p.name }))}
					onChange={(projectId) => patch({ projectId, model: "" })}
				/>
				<Picker
					label="Model"
					placeholder="Choose a model"
					value={d().model || null}
					disabled={!d().projectId || models()?.projectId !== d().projectId}
					items={(models()?.projectId === d().projectId ? (models()?.items ?? []) : []).map((m) => ({
						value: m.id,
						title: `${m.name} (${m.provider})`,
					}))}
					onChange={(model) => patch({ model })}
				/>
				<If when={models()?.projectId === d().projectId && models()?.items === null}>
					<Meta text="Configured models could not be read." />
				</If>
				<Field
					label="Per report (USD)"
					value={d().perReportUsd}
					onChange={(perReportUsd) => patch({ perReportUsd })}
					testID="insights-report-limit"
				/>
				<Field
					label="Per month (USD)"
					value={d().monthlyUsd}
					onChange={(monthlyUsd) => patch({ monthlyUsd })}
					testID="insights-monthly-limit"
				/>
			</View>
			<View class="gap-2">
				<SectionTitle title="Schedule" />
				<If when={s().applied} else={<Meta text="Manual only. You can choose a schedule after setup." />}>
					<CheckboxRow
						label="Run weekly"
						checked={!!d().schedule}
						onChange={() => patch({ schedule: d().schedule ? null : { weekday: 1, time: "", timeZone: "" } })}
					/>
					<If when={d().schedule}>
						<Picker
							label="Day"
							placeholder="Choose a day"
							value={String(d().schedule?.weekday ?? 1)}
							items={days.map((title, value) => ({ title, value: String(value) }))}
							onChange={(day) => updateSchedule({ weekday: Number(day) })}
						/>
						<Field
							label="Local time (HH:MM)"
							value={d().schedule?.time ?? ""}
							onChange={(time) => updateSchedule({ time })}
						/>
						<Field
							label="Time zone"
							placeholder="Europe/Paris"
							value={d().schedule?.timeZone ?? ""}
							onChange={(timeZone) => updateSchedule({ timeZone })}
						/>
					</If>
				</If>
			</View>
			<View class="flex-row flex-wrap gap-2">
				<Action
					label={s().applied ? "Review and apply…" : "Review setup…"}
					testID="insights-review"
					variant="primary"
					disabled={!valid()}
					onPress={() => prepare(s().applied ? "apply" : "setup")}
				/>
				<If when={s().applied}>
					<Action label="Save draft" disabled={!valid()} onPress={() => prepare("save")} />
				</If>
			</View>
		</View>
	);
}
function Items(props: {
	kind: "reports" | "findings";
	current: InsightsSnapshot;
	controls: InsightsControls;
	showLegacy: (item: InsightsDetail | null) => void;
}) {
	const history = signal(false);
	const kind = () => props.kind;
	const list = () => props.current[kind()];
	const legacy = () => props.current.legacy;
	return (
		<View class="gap-2">
			<SectionTitle title={kind() === "reports" ? "Saved reports" : "Saved findings"} />
			<If
				when={list().unavailable}
				else={
					<If when={!list().items.length}>
						<Meta text={kind() === "reports" ? "No reports yet." : "No findings yet."} />
					</If>
				}
			>
				<Meta text="This list could not be read." />
			</If>
			<Each of={list().items} key={(i) => i.key}>
				{(i) => (
					<DividedRow open={false} content={null}>
						<View class="flex-row items-center gap-2 py-2">
							<View class="min-w-0 flex-1 gap-1">
								<Text class="text-sm text-foreground">{i().title}</Text>
								<If when={i().updatedAt > 0}>
									<Meta text={new Date(i().updatedAt).toLocaleDateString()} />
								</If>
							</View>
							<Action
								label="Open"
								accessibilityLabel={`Open ${i().title}`}
								testID={`insights-item-${i().key}`}
								onPress={() => {
									props.showLegacy(null);
									insightsSelection.set({ kind: kind(), key: i().key });
								}}
							/>
						</View>
					</DividedRow>
				)}
			</Each>
			<If when={list().nextCursor !== null}>
				<View class="self-start">
					<Action
						label="Show more"
						disabled={props.controls.busy()}
						onPress={() => void props.controls.more(kind())}
					/>
				</View>
			</If>
			<If when={legacy().state !== "empty"}>
				<View class="self-start">
					<Action
						label={history() ? "Hide earlier history" : "Earlier history"}
						onPress={() => history.set(!history())}
					/>
				</View>
				<If when={history()}>
					<If
						when={legacy().state === "unavailable"}
						else={<Meta text="Earlier Insights is read-only. No source access or schedule carries over." />}
					>
						<Meta text="Earlier history could not be confirmed." />
					</If>
					<Each of={legacy()[kind()]} key={(i) => i.key}>
						{(i) => (
							<DividedRow open={false} content={null}>
								<View class="flex-row items-center gap-2 py-2">
									<View class="min-w-0 flex-1">
										<Text class="text-sm text-foreground">{i().title}</Text>
									</View>
									<Action
										label="Read"
										accessibilityLabel={`Read ${i().title}`}
										onPress={() => {
											insightsSelection.set(null);
											props.showLegacy({ ...i(), legacy: true });
										}}
									/>
								</View>
							</DividedRow>
						)}
					</Each>
					<If
						when={legacy().nextCursor}
						else={
							<If when={legacy().more}>
								<Meta text="More earlier records may exist." />
							</If>
						}
					>
						<View class="self-start">
							<Action
								label="Show more earlier records"
								disabled={props.controls.busy()}
								onPress={() => void props.controls.moreHistory()}
							/>
						</View>
					</If>
				</If>
			</If>
		</View>
	);
}

export function InsightsScreen(props: Props) {
	const c = props.controls;
	const s = c.snapshot;
	const selected = signal<InsightsDetail | null>(null);
	const legacy = signal<InsightsDetail | null>(null);
	const failedDetail = signal(false);
	const tab = insightsTab;
	const locked = () => !c.fresh() || c.busy() || !!c.pending().length || !!insightsReview();
	const pauseLocked = () => !c.fresh() || c.busy() || !s()?.canPause;
	const current = () => legacy() ?? selected();
	function choose(id: (typeof tabs)[number]["id"]) {
		insightsReview.set(null);
		legacy.set(null);
		insightsSelection.set(null);
		tab.set(id);
	}
	untracked(() => void c.read());
	let sequence = 0;
	let openedLatest = false;
	effect(() => {
		const latest = s()?.reports.items[0];
		if (!latest || openedLatest) return;
		openedLatest = true;
		untracked(() => {
			if (!insightsSelection() && tab() === "reports") insightsSelection.set({ kind: "reports", key: latest.key });
		});
	});
	effect(() => {
		const pick = insightsSelection();
		// Refresh the selected detail when its row changes. Keep the old view while reading.
		const revision = pick ? s()?.[pick.kind].items.find((i) => i.key === pick.key)?.revision : undefined;
		const request = ++sequence;
		if (untracked(selected)?.key !== pick?.key) selected.set(null);
		failedDetail.set(false);
		if (pick)
			untracked(
				() =>
					void c.item(pick.kind, pick.key).then((value) => {
						if (sequence !== request) return;
						if (!value || (revision !== undefined && value.revision < revision)) failedDetail.set(true);
						else selected.set(value);
					}),
			);
	});
	let active = true;
	let actionGeneration = 0;
	let reviewedDraft: InsightsDraft | null = null;
	cleanup(() => {
		sequence++;
		active = false;
		insightsReview.set(null);
	});
	keymap.bind(
		"escape",
		() => {
			Keyboard.dismiss();
			actionGeneration++;
			if (insightsReview()) insightsReview.set(null);
			else if (legacy()) legacy.set(null);
			else if (insightsSelection()) insightsSelection.set(null);
			else if (!props.onBack?.()) closeInsights();
		},
		{ when: "always" },
	);
	async function prepare(intent: InsightsIntent) {
		const snapshot = s();
		if (!snapshot || (intent.action === "pause" ? pauseLocked() || !!insightsReview() : locked())) return;
		const generation = ++actionGeneration;
		const from = tab();
		const selection = insightsSelection();
		const draft = insightsDraft();
		const review = await c.prepare(snapshot.binding, intent);
		if (!review || !active || generation !== actionGeneration || tab() !== from || insightsSelection() !== selection)
			return;
		if ("settings" in intent && insightsDraft() !== draft) return;
		if (intent.action === "save" || intent.action === "run") {
			if ((await c.confirm(review.token)) && intent.action === "save" && insightsDraft() === draft)
				insightsDraft.set(null);
		} else {
			reviewedDraft = draft;
			insightsReview.set(review);
		}
	}
	return (
		<Scroll class="flex-1 bg-background">
			<Page testID="insights" gap={8}>
				<View class="gap-2">
					<PageTitle title="Insights" />
					<Meta text="Find improvements in the chats you choose to include." />
					<View class="self-start">
						<TabRow>
							<Each of={tabs} key={(t) => t.id}>
								{(t) => (
									<TabItem
										label={t().label}
										selected={tab() === t().id}
										onPress={() => choose(t().id)}
										testID={`insights-${t().id}`}
									/>
								)}
							</Each>
						</TabRow>
					</View>
				</View>
				<If when={c.message()}>
					<Notice text={c.message()} />
				</If>
				<Each of={c.pending()} key={(p) => p.id}>
					{(p) => (
						<Notice
							text={
								p().checking
									? "Checking the saved outcome. Nothing is sent again."
									: "This action is unconfirmed. Nothing is sent again."
							}
						>
							<If when={!p().checking}>
								<Action label="Check status" onPress={() => void c.check(p().id)} />
							</If>
						</Notice>
					)}
				</Each>
				<If when={insightsReview()}>
					{(review) => (
						<Panel class="gap-3" tone="card">
							<SectionTitle title={review().label} />
							<Each of={review().lines} key="index">
								{(line) => <Meta text={line()} />}
							</Each>
							<View class="flex-row flex-wrap gap-2">
								<Action label="Cancel" disabled={c.busy()} onPress={() => insightsReview.set(null)} />
								<Action
									label={review().label}
									testID="insights-confirm"
									variant="primary"
									agent={{ confirm: "Confirm this Insights change" }}
									disabled={
										review().intent.action === "pause"
											? pauseLocked()
											: !c.fresh() || c.busy() || !!c.pending().length
									}
									onPress={async () => {
										const approved = review();
										const draft = reviewedDraft;
										const saved = await c.confirm(approved.token);
										if (
											saved &&
											["setup", "apply"].includes(approved.intent.action) &&
											insightsDraft() === draft
										) {
											insightsDraft.set(null);
										}
										if (insightsReview() === approved) insightsReview.set(null);
									}}
								/>
							</View>
						</Panel>
					)}
				</If>
				<If when={s()} else={<Meta text="Insights could not be read yet." />}>
					{(snap) => (
						<>
							<If
								when={tab() === "settings"}
								else={
									<View class="gap-6">
										<If when={tab() === "reports"}>
											<View class="gap-3">
												<View class="flex-row flex-wrap items-center gap-3">
													<If
														when={snap().state === "off"}
														else={
															<Action
																label="Run report"
																variant="primary"
																testID="insights-run"
																agent={{
																	confirm: "Run a report with the applied sources and allowances",
																}}
																disabled={locked() || !(snap().canRun ?? snap().state === "enabled")}
																onPress={() => void prepare({ action: "run" })}
															/>
														}
													>
														<Action
															label="Set up Insights…"
															variant="primary"
															onPress={() => choose("settings")}
														/>
													</If>
													<Meta text={labels[snap().state] ?? "Unavailable"} />
												</View>
												<Meta
													text={
														snap().reason ??
														(snap().applied?.schedule
															? "Scheduled reports use your chosen time zone."
															: "Manual only. No scheduled reports.")
													}
												/>
												<If when={snap().applied}>
													{(settings) => <RunScope settings={settings()} projects={snap().projects} />}
												</If>
												<If when={snap().allowance}>
													{(a) => (
														<Meta
															text={`${money(a().reportRemainingUsd)} left for this report. ${money(a().monthRemainingUsd)} left this month.`}
														/>
													)}
												</If>
												<If when={snap().nextAt}>
													<Meta
														text={`Next scheduled report: ${new Date(snap().nextAt ?? 0).toLocaleString()} (local time)`}
													/>
												</If>
											</View>
										</If>
										<If when={failedDetail()}>
											<Notice text="The selected item could not be read." />
										</If>
										<If when={current()}>
											{(item) => (
												<Detail
													{...props}
													detail={item()}
													locked={locked()}
													prepare={(i) => void prepare(i)}
												/>
											)}
										</If>
										<If when={!current() && insightsSelection() && !failedDetail()}>
											<Meta text="Reading the saved item…" />
										</If>
										<Items
											kind={tab() === "findings" ? "findings" : "reports"}
											current={snap()}
											controls={c}
											showLegacy={(item) => legacy.set(item)}
										/>
									</View>
								}
							>
								<Settings current={snap()} controls={c} locked={locked()} prepare={(i) => void prepare(i)} />
								<View class="flex-row gap-2">
									<If when={snap().state === "paused"}>
										<Action
											label="Resume Insights…"
											disabled={locked()}
											onPress={() => void prepare({ action: "resume" })}
										/>
									</If>
									<If when={snap().canPause}>
										<Action
											label="Pause Insights…"
											disabled={pauseLocked() || !!insightsReview()}
											onPress={() => void prepare({ action: "pause" })}
										/>
									</If>
								</View>
							</If>
						</>
					)}
				</If>
			</Page>
		</Scroll>
	);
}
