// Native-owned allowances, with one explicit approval and no automatic resumption.
import { Text, View } from "nsh";
import type { ModelControls } from "./modelControls";
import { fundingDraft as draft } from "./modelSettingsDraft";
import { Action, Field, Picker, SectionTitle } from "./ui";

const money = (n: number | null | undefined) => (n == null ? "Not set" : `$${(n / 1_000_000).toFixed(2)}`);
export function fundingAmount(text: string): number | null | undefined {
	if (!text.trim()) return null;
	if (!/^\d+(?:\.\d{1,6})?$/.test(text.trim())) return undefined;
	const n = Math.round(Number(text) * 1_000_000);
	return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}
export function FundingSettings(props: { controls: ModelControls }) {
	const settings = () => props.controls.settings(),
		view = () => settings()?.funding;
	const locked = () => props.controls.busy() || props.controls.unknown().length > 0;
	const begin = () => {
		const s = settings(),
			v = view();
		if (!s || !v) return;
		draft.set({
			project: s.project?.id ?? "",
			binding: s.binding,
			daily: v.dailyMicros === null ? "" : String(v.dailyMicros / 1_000_000),
			mission: v.missionDefaultMicros === null ? "" : String(v.missionDefaultMicros / 1_000_000),
			quickFix: v.quickFixDefaultMicros === null ? "" : String(v.quickFixDefaultMicros / 1_000_000),
			session: "",
			amount: "",
		});
	};
	const edit = (key: "daily" | "mission" | "quickFix" | "session" | "amount", value: string) => {
		const d = draft();
		if (d) draft.set({ ...d, [key]: value });
	};
	const elsewhere = () => !!draft() && draft()?.project !== (settings()?.project?.id ?? "");
	return (
		<View testID="funding-settings" class="gap-3 border-t border-border pt-4">
			<SectionTitle title="Allowances" />
			<Text class="text-xs text-faint">
				New native work uses these allowances. Legacy desktop chats keep their existing controls until migration.
			</Text>
			<Text class="text-sm text-muted-foreground">
				Catalog value, including subscription models. Planning, retries, helpers and reviews count once. Missing
				prices or request bounds hold only affected work.
			</Text>
			<If
				when={view()}
				else={
					<Text class="text-sm text-needs-ink">Allowances unavailable. No spending permission is implied.</Text>
				}
			>
				{(v) => (
					<View class="gap-3">
						<Text class="text-sm text-foreground">{`Background: ${money(v().background.spentMicros)} used, ${money(v().background.uncertainMicros)} uncertain, ${money(v().background.remainingMicros)} left.`}</Text>
						<If when={v().background.heldMaximumMicros}>
							<Text class="text-sm text-needs-ink">{`Last background request needed a ${money(v().background.heldMaximumMicros)} reservation. Increase its daily allowance or wait for reset.`}</Text>
						</If>
						<Text class="text-xs text-faint">{`Daily allowance ${money(v().dailyMicros)}. Resets at ${v().resetAt} (UTC). Uncertain charges survive reset.`}</Text>
						<Each of={v().backgroundJobs ?? []} key={(j) => `${j.job}:${j.projectId ?? "unknown"}`}>
							{(j) => (
								<Text class="text-xs text-muted-foreground">{`${j().job} · ${j().projectId ?? "Project unknown"}: ${money(j().spentMicros)} used, ${money(j().uncertainMicros)} uncertain.`}</Text>
							)}
						</Each>
						<If when={settings()?.project}>
							<Text class="text-sm text-muted-foreground">{`New missions: ${money(v().missionDefaultMicros)} for their lifetime. New quick fixes: ${money(v().quickFixDefaultMicros)}. Defaults do not refill existing work.`}</Text>
						</If>
						<Each of={v().accounts} key={(a) => `${a.kind}:${a.id}`}>
							{(a) => (
								<View class="gap-1">
									<Text class="text-sm text-muted-foreground">{`${a().kind === "mission" ? "Mission" : "Quick fix"} ${settings()?.fundedWork?.find((w) => w.owner.kind === a().kind && w.owner.id === a().id)?.title ?? a().id}: ${money(a().spentMicros)} used, ${money(a().uncertainMicros)} uncertain, ${money(a().remainingMicros)} left of ${money(a().limitMicros)}.`}</Text>
									<If when={a().heldMaximumMicros}>
										<Text class="text-xs text-needs-ink">{`Last request needed a ${money(a().heldMaximumMicros)} reservation. Approve a larger total to continue; other holds stay.`}</Text>
									</If>
								</View>
							)}
						</Each>
						<If when={v().accountCount > v().accounts.length}>
							<Text class="text-xs text-faint">{`Showing ${v().accounts.length} of ${v().accountCount} allowances.`}</Text>
						</If>
						<If when={!draft()}>
							<Action label="Change allowances" testID="funding-edit" disabled={locked()} onPress={begin} />
						</If>
					</View>
				)}
			</If>
			<If when={draft()}>
				{(d) => (
					<View class="gap-3">
						<If
							when={elsewhere()}
							else={
								<View class="gap-3">
									<Field
										label="Daily background allowance (USD catalog value)"
										testID="funding-daily"
										value={d().daily}
										onChange={(v) => edit("daily", v)}
										placeholder="Not set"
									/>
									<If when={settings()?.project}>
										<View class="gap-3">
											<Field
												label="New mission default (USD)"
												value={d().mission}
												onChange={(v) => edit("mission", v)}
												placeholder="Ask at creation"
											/>
											<Field
												label="New quick-fix default (USD)"
												value={d().quickFix}
												onChange={(v) => edit("quickFix", v)}
												placeholder="Ask at creation"
											/>
										</View>
									</If>
									<Action
										label="Save allowance settings"
										testID="funding-save"
										disabled={
											locked() ||
											[d().daily, d().mission, d().quickFix].some((v) => fundingAmount(v) === undefined)
										}
										onPress={() =>
											void props.controls
												.write(
													"funding-settings",
													{
														dailyMicros: fundingAmount(d().daily),
														missionDefaultMicros: fundingAmount(d().mission),
														quickFixDefaultMicros: fundingAmount(d().quickFix),
													},
													d().binding,
												)
												.then((ok) => {
													if (ok) draft.set(null);
												})
										}
									/>
									<If when={settings()?.project}>
										<View class="gap-3 border-t border-border pt-3">
											<Picker
												label="Fund existing work"
												placeholder="Choose work"
												value={d().session || null}
												items={(settings()?.fundedWork ?? []).map((w) => ({ value: w.id, title: w.title }))}
												onChange={(v) => edit("session", v)}
											/>
											<Field
												label="New total allowance (USD, not an added amount)"
												value={d().amount}
												onChange={(v) => edit("amount", v)}
												placeholder="Enter an amount"
											/>
											<Text class="text-xs text-faint">
												Only explicit increases change an existing allowance. This does not clear Pause,
												Stop, subscription or required-review holds.
											</Text>
											<Action
												label="Approve allowance"
												testID="funding-approve"
												disabled={locked() || !d().session || fundingAmount(d().amount) == null}
												onPress={() =>
													void props.controls
														.write(
															"fund-work",
															{ sessionId: d().session, amountMicros: fundingAmount(d().amount) },
															d().binding,
														)
														.then((ok) => {
															if (ok) draft.set(null);
														})
												}
											/>
										</View>
									</If>
								</View>
							}
						>
							<Text class="text-sm text-needs-ink">
								An allowance draft belongs to another project. Return there or discard it.
							</Text>
						</If>
						<Action label="Discard allowance draft" onPress={() => draft.set(null)} disabled={locked()} />
					</View>
				)}
			</If>
			<Each
				of={(settings()?.fundedWork ?? []).filter((w) => w.subscription && !w.subscription.forced)}
				key={(w) => w.id}
			>
				{(w) => (
					<View class="gap-2 border-t border-border pt-3">
						<Text class="text-sm text-needs-ink">{`${w().title}: subscription usage is at its limit.`}</Text>
						<Text class="text-xs text-faint">
							Continue anyway applies only to this chat and its helpers. Other spending and work holds stay.
						</Text>
						<Action
							label="Continue anyway"
							disabled={locked()}
							onPress={() => void props.controls.write("continue-anyway", w().id)}
						/>
					</View>
				)}
			</Each>
			<Each
				of={[
					...new Set(
						(settings()?.backgroundSubscription?.windows ?? [])
							.filter((w) => !settings()?.backgroundSubscription?.force?.includes(w.provider))
							.map((w) => w.provider),
					),
				]}
				key={(p) => p}
			>
				{(p) => (
					<View class="gap-2 border-t border-border pt-3">
						<Text class="text-sm text-needs-ink">{`Background work is held by ${p()} subscription usage.`}</Text>
						<Action
							label={`Continue background anyway (${p()})`}
							disabled={locked()}
							onPress={() => void props.controls.write("background-continue", p())}
						/>
					</View>
				)}
			</Each>
		</View>
	);
}
