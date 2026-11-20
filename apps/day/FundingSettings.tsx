// Native-owned allowances, with one explicit approval and no automatic resumption. Settings shows them in their own
// Allowances tab; spending limits turn on and off at once, everything else is a draft until Save or Approve.
import { effect, untracked, View } from "nsh";
import { ModelStatus } from "./ModelSettings";
import type { ModelControls } from "./modelControls";
import { fundingDraft as draft } from "./modelSettingsDraft";
import {
	Block,
	Body,
	Button,
	Buttons,
	Caption,
	EmptyLine,
	Field,
	Link,
	Notice,
	Num,
	Picker,
	Row,
	RowDetail,
	Rows,
	Section,
	Switch,
} from "./ui";

const money = (n: number | null | undefined) => (n == null ? "Not set" : `$${(n / 1_000_000).toFixed(2)}`);
export function fundingAmount(text: string): number | null | undefined {
	if (!text.trim()) return null;
	if (!/^\d+(?:\.\d{1,6})?$/.test(text.trim())) return undefined;
	const n = Math.round(Number(text) * 1_000_000);
	return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}
/**
 * The allowances section. `standalone` is the Allowances tab on its own: it reads the controls itself and shows
 * their status (what the last action said, an Unknown action's Check), which the AI tab shows otherwise.
 */
export function FundingSettings(props: { controls: ModelControls; standalone?: boolean }) {
	if (props.standalone)
		effect(() => {
			untracked(() => void props.controls.read());
		});
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
	const limited = () => view()?.enabled !== false;
	return (
		<View testID="funding-settings">
			<Section
				title="Allowances"
				action={
					<If when={limited() && view() && !draft()}>
						<Link label="Change allowances" testID="funding-edit" disabled={locked()} onPress={begin} />
					</If>
				}
			>
				<If when={props.standalone}>
					<ModelStatus controls={props.controls} />
				</If>
				<Rows>
					<If when={view()}>
						{(v) => (
							<Row
								title="Limit spending"
								meta={
									limited()
										? "New native work uses these allowances. Legacy desktop chats keep their existing controls until migration."
										: undefined
								}
								wrap
								trailing={
									<Switch
										testID="funding-limits"
										accessibilityLabel="Limit spending"
										checked={v().enabled}
										disabled={locked()}
										onChange={() => void props.controls.write("funding-limits", !v().enabled)}
									/>
								}
							/>
						)}
					</If>
				</Rows>
				<If
					when={limited()}
					else={
						<EmptyLine testID="funding-off" text="Spending limits are off. Pilot does not stop work for cost." />
					}
				>
					<Block>
						<Body tone="muted" measure>
							Catalog value, including subscription models. Planning, retries, helpers and reviews count once.
							Missing prices or request bounds hold only affected work.
						</Body>
					</Block>
					<If
						when={view()}
						else={
							<Notice
								kind="needs"
								placement="section"
								text="Allowances unavailable. No spending permission is implied."
							/>
						}
					>
						{(v) => (
							<>
								<Rows>
									<Row
										title="Background"
										meta={`${money(v().background.spentMicros)} used, ${money(v().background.uncertainMicros)} uncertain, ${money(v().background.remainingMicros)} left.`}
										wrap
										detail={
											<If when={v().background.heldMaximumMicros}>
												<RowDetail>
													<Caption tone="needs">{`Last background request needed a ${money(v().background.heldMaximumMicros)} reservation. Increase its daily allowance or wait for reset.`}</Caption>
												</RowDetail>
											</If>
										}
									/>
									<Row
										title="Daily allowance"
										meta={`Resets at ${v().resetAt} (UTC). Uncertain charges survive reset.`}
										wrap
										trailing={<Num>{money(v().dailyMicros)}</Num>}
									/>
									<Each of={v().backgroundJobs ?? []} key={(j) => `${j.job}:${j.projectId ?? "unknown"}`}>
										{(j) => (
											<Row
												title={`${j().job} · ${j().projectId ?? "Project unknown"}`}
												meta={`${money(j().spentMicros)} used, ${money(j().uncertainMicros)} uncertain.`}
											/>
										)}
									</Each>
									<Each of={v().accounts} key={(a) => `${a.kind}:${a.id}`}>
										{(a) => (
											<Row
												title={`${a().kind === "mission" ? "Mission" : "Quick fix"} ${settings()?.fundedWork?.find((w) => w.owner.kind === a().kind && w.owner.id === a().id)?.title ?? a().id}`}
												meta={`${money(a().spentMicros)} used, ${money(a().uncertainMicros)} uncertain, ${money(a().remainingMicros)} left of ${money(a().limitMicros)}.`}
												wrap
												detail={
													<If when={a().heldMaximumMicros}>
														<RowDetail>
															<Caption tone="needs">{`Last request needed a ${money(a().heldMaximumMicros)} reservation. Approve a larger total to continue; other holds stay.`}</Caption>
														</RowDetail>
													</If>
												}
											/>
										)}
									</Each>
								</Rows>
								<If when={settings()?.project}>
									<Block>
										<Body tone="muted">{`New missions: ${money(v().missionDefaultMicros)} for their lifetime. New quick fixes: ${money(v().quickFixDefaultMicros)}. Defaults do not refill existing work.`}</Body>
									</Block>
								</If>
								<If when={v().accountCount > v().accounts.length}>
									<EmptyLine text={`Showing ${v().accounts.length} of ${v().accountCount} allowances.`} />
								</If>
							</>
						)}
					</If>
					<If when={draft()}>
						{(d) => (
							<Block gap={3}>
								<If
									when={elsewhere()}
									else={
										<>
											<Field
												label="Daily background allowance (USD catalog value)"
												testID="funding-daily"
												value={d().daily}
												onChange={(v) => edit("daily", v)}
												placeholder="Not set"
											/>
											<If when={settings()?.project}>
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
											</If>
											<Buttons>
												<Button
													kind="primary"
													label="Save allowance settings"
													testID="funding-save"
													disabled={
														locked() ||
														[d().daily, d().mission, d().quickFix].some(
															(v) => fundingAmount(v) === undefined,
														)
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
												<Button
													label="Discard allowance draft"
													onPress={() => draft.set(null)}
													disabled={locked()}
												/>
											</Buttons>
											<If when={settings()?.project}>
												<Picker
													label="Fund existing work"
													placeholder="Choose work"
													value={d().session || null}
													items={(settings()?.fundedWork ?? []).map((w) => ({
														value: w.id,
														title: w.title,
													}))}
													onChange={(v) => edit("session", v)}
												/>
												<Field
													label="New total allowance (USD, not an added amount)"
													value={d().amount}
													onChange={(v) => edit("amount", v)}
													placeholder="Enter an amount"
												/>
												<Caption tone="faint">
													Only explicit increases change an existing allowance. This does not clear Pause,
													Stop, subscription or required-review holds.
												</Caption>
												<Buttons>
													<Button
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
												</Buttons>
											</If>
										</>
									}
								>
									<Notice
										kind="needs"
										placement="flow"
										text="An allowance draft belongs to another project. Return there or discard it."
										action={
											<Link
												label="Discard allowance draft"
												disabled={locked()}
												onPress={() => draft.set(null)}
											/>
										}
									/>
								</If>
							</Block>
						)}
					</If>
				</If>
				<Each
					of={(settings()?.fundedWork ?? []).filter((w) => w.subscription && !w.subscription.forced)}
					key={(w) => w.id}
				>
					{(w) => (
						<Notice
							kind="needs"
							placement="section"
							text={`${w().title}: subscription usage is at its limit.`}
							detail="Continue anyway applies only to this chat and its helpers. Other spending and work holds stay."
							action={
								<Button
									small
									label="Continue anyway"
									disabled={locked()}
									onPress={() => void props.controls.write("continue-anyway", w().id)}
								/>
							}
						/>
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
						<Notice
							kind="needs"
							placement="section"
							text={`Background work is held by ${p()} subscription usage.`}
							action={
								<Button
									small
									label={`Continue background anyway (${p()})`}
									disabled={locked()}
									onPress={() => void props.controls.write("background-continue", p())}
								/>
							}
						/>
					)}
				</Each>
			</Section>
		</View>
	);
}
