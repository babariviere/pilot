// AI settings: the window's models, work profiles, shared defaults and provider sign-in, as sections of the
// Settings panel's AI tab. Sign-in challenges and answers are ephemeral, never part of saved drafts or messages.
import { effect, signal, untracked, View } from "nsh";
import type { ModelControls, ModelRecovery, ModelSettings, SignInView } from "./modelControls";
import {
	modelDraft as draft,
	modelEdit as edit,
	modelEditBinding,
	modelEditProject,
	modelPatterns as patterns,
	modelReplacement as replacement,
} from "./modelSettingsDraft";
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
	Picker,
	Quote,
	Row,
	RowDetail,
	Rows,
	Section,
} from "./ui";
import { WorkProfiles } from "./WorkProfiles";

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function effective(s: ModelSettings, task: boolean): string {
	const list = task ? s.task : s.available;
	const requested = s.project?.model ?? (task ? list.defaultModel : undefined);
	const id = requested ?? list.resolvedDefaultModel;
	const model = list.models.find((m) => m.id === id);
	if (!model && !task && !s.project?.model)
		return `Pi selects at start. Configured default: ${list.defaultModel ?? "none"}; no effective Build value is reported here. Check the actual chat's model.`;
	if (!model)
		return `${requested ?? "Default model"} is unavailable. Choose an eligible model; Pilot will not replace it silently.`;
	const fallback =
		!task && !s.project?.model && list.defaultModel && list.defaultModel !== model.id
			? ` Pi starts this model instead of configured ${list.defaultModel}.`
			: "";
	return `${model.name} (${model.id}), thinking ${task ? (model.taskDefaultThinking ?? "not reported") : (model.defaultThinking ?? "not reported")}${fallback}`;
}

function FailedWork(props: { controls: ModelControls; id: string; title: string }) {
	const read = signal<ModelRecovery | null>(null);
	const model = signal("");
	const thinking = signal("");
	const choice = () => read()?.choices.models.find((m) => m.id === model());
	return (
		<Row
			mark="failed"
			title={props.title}
			meta="Only this chat is affected. Choosing a model saves it for an explicit next attempt; it does not restart work."
			wrap
			trailing={
				<Button
					small
					label="Choose a replacement"
					disabled={props.controls.busy()}
					onPress={() =>
						void props.controls.recovery(props.id).then((r) => {
							read.set(r);
							model.set("");
							thinking.set("");
						})
					}
				/>
			}
			detail={
				<If when={read()}>
					{(r) => (
						<RowDetail>
							<If when={r().choices.models.length === 0}>
								<Caption tone="needs">
									No eligible replacement for this chat. Check sign-in, its scope and the price ceiling.
								</Caption>
							</If>
							<Buttons>
								<Picker
									label="Replacement for this chat"
									items={r().choices.models.map((m) => ({ value: m.id, title: m.name }))}
									value={model() || null}
									placeholder="Choose an eligible model"
									disabled={props.controls.busy()}
									onChange={(id) => {
										model.set(id);
										thinking.set(r().choices.models.find((m) => m.id === id)?.taskDefaultThinking ?? "");
									}}
								/>
								<If when={choice()}>
									<Picker
										label="Replacement thinking"
										items={(choice()?.thinkingLevels ?? []).map((level) => ({ value: level, title: level }))}
										value={thinking()}
										placeholder="Choose supported thinking"
										disabled={props.controls.busy()}
										onChange={thinking.set}
									/>
								</If>
								<Button
									small
									label="Save for next attempt"
									disabled={
										props.controls.busy() || props.controls.unknown().length > 0 || !choice() || !thinking()
									}
									onPress={() =>
										void props.controls
											.write("failed-model", {
												sessionId: props.id,
												source: r().source,
												model: model(),
												thinking: thinking(),
											})
											.then((ok) => {
												if (ok) read.set(null);
											})
									}
								/>
							</Buttons>
						</RowDetail>
					)}
				</If>
			}
		/>
	);
}

/**
 * What the last AI settings action said, and the actions whose answer was lost. Shown in the AI and Allowances
 * tabs, which share these controls. Check only looks up a receipt; nothing is sent again.
 */
export function ModelStatus(props: { controls: ModelControls }) {
	const c = props.controls;
	return (
		<>
			<If when={c.message()}>
				<Block>
					<Caption testID="models-message">{c.message()}</Caption>
				</Block>
			</If>
			<Each of={c.unknown()} key={(o) => o.operationId}>
				{(o) => (
					<Notice
						kind="unconfirmed"
						placement="section"
						text="An earlier AI settings action is Unknown. No automatic retry."
						action={
							<Link
								label="Check receipt"
								testID="models-check"
								disabled={c.busy()}
								onPress={() => void c.check(o().operationId)}
							/>
						}
					/>
				)}
			</Each>
		</>
	);
}

export function ModelSettingsSection(props: { controls: ModelControls }) {
	const c = props.controls;
	const challenge = signal<SignInView | null>(null);
	const answer = signal("");
	const logout = signal<string | null>(null);
	const s = () => c.settings();
	const disabled = () => c.busy() || c.unknown().length > 0;
	const items = () => (s()?.task.models ?? []).map((m) => ({ value: m.id, title: m.name }));
	const changeDefault = (model: string) => {
		const slash = model.indexOf("/");
		const d = draft();
		if (d)
			draft.set({
				...d,
				defaultProvider: slash < 0 ? null : model.slice(0, slash),
				defaultModel: slash < 0 ? null : model.slice(slash + 1),
			});
	};
	const save = async () => {
		if (modelEditProject() !== (s()?.project?.id ?? "")) return;
		const d = draft();
		if (edit() === "scope") {
			if (await c.write("scope", patterns(), modelEditBinding())) edit.set(null);
		} else if (d) {
			const n = replacement().trim() === "" ? null : Number(replacement());
			if (n !== null && (!Number.isFinite(n) || n <= 0)) return;
			if (await c.write("defaults", { ...d, pilotTaskPriceLimit: n }, modelEditBinding())) edit.set(null);
		}
	};
	const checkRun = async (id: string) => {
		answer.set("");
		challenge.set(await c.signIn(id, "read"));
		await c.read();
	};
	effect(() => {
		untracked(() => void c.read());
	});
	return (
		<View testID="model-settings">
			<Section
				title="AI"
				note={s()?.project ? `Project: ${s()?.project?.name}` : "Shared settings for all projects"}
				action={
					<Link
						label={c.busy() ? "Reading…" : "Read again"}
						testID="models-read"
						disabled={c.busy()}
						onPress={() => void c.read()}
					/>
				}
			>
				<Block>
					<Body tone="muted" measure>
						Choose models for new work. Running chats keep their current model. Advanced Pi configuration stays
						unchanged.
					</Body>
				</Block>
				<ModelStatus controls={c} />
			</Section>
			<If when={s()}>
				{(read) => (
					<>
						<Block>
							<WorkProfiles controls={c} settings={read()} />
						</Block>
						<Section title="Effective choices">
							<If
								when={read().project}
								else={
									<Block>
										<Body tone="muted">
											Choose a project in Today to see its effective model, thinking and price ceiling.
											Shared settings and sign-in stay available below.
										</Body>
									</Block>
								}
							>
								<Block>
									<Body testID="models-effective-task" tone="muted">
										{`Mission/task start: ${effective(read(), true)}`}
									</Body>
									<Body testID="models-effective-build" tone="muted">
										{`Fresh Build: ${effective(read(), false)}`}
									</Body>
									<Body testID="models-price" tone="muted">
										{read().task.priceCeiling?.limit != null
											? `Task-start ceiling: $${read().task.priceCeiling?.limit}/M input + output (${read().task.priceCeiling?.source}).`
											: "Reference prices unavailable. New task starts are held until you set a replacement limit."}
									</Body>
									<Caption tone="faint">
										Prepared copies, Ask profiles and existing chats can differ. A running chat's reported
										choice is authoritative.
									</Caption>
								</Block>
							</If>
						</Section>
						<Section title="Models">
							<Rows>
								<If when={read().project}>
									<Row
										title="Project model override"
										meta={`Pi project scope: ${read().scope.projectOverride === null ? "inherits shared scope" : JSON.stringify(read().scope.projectOverride)}. Pi project defaults may override shared defaults.`}
										wrap
										trailing={
											<Picker
												testID="models-project"
												label="Project model override"
												items={[{ value: "inherit", title: "Use Pi defaults" }, ...items()]}
												value={read().project?.model ?? "inherit"}
												placeholder={read().project?.model ?? "Use Pi defaults"}
												searchable
												disabled={disabled()}
												onChange={(v) => void c.write("project-model", v === "inherit" ? null : v)}
											/>
										}
									/>
								</If>
								<Row
									title="Shared defaults"
									meta={
										read().defaults.defaultModel
											? `${read().defaults.defaultProvider ?? ""}/${read().defaults.defaultModel}`
											: "Pi chooses the default"
									}
									trailing={
										<Button
											small
											label="Edit defaults"
											testID="models-edit-defaults"
											disabled={disabled() || edit() !== null}
											onPress={() => {
												modelEditBinding.set(read().binding);
												modelEditProject.set(read().project?.id ?? "");
												draft.set({ ...read().defaults });
												replacement.set(read().defaults.pilotTaskPriceLimit?.toString() ?? "");
												edit.set("defaults");
											}}
										/>
									}
								/>
								<If when={edit() === "defaults"}>
									<Row
										title="Shared default model"
										trailing={
											<Picker
												testID="models-default"
												label="Shared default model"
												items={[
													{ value: "inherit", title: "Let Pi choose" },
													...read().scope.candidates.map((m) => ({ value: m.id, title: m.name })),
												]}
												value={
													draft()?.defaultModel
														? `${draft()?.defaultProvider}/${draft()?.defaultModel}`
														: "inherit"
												}
												placeholder="Choose a shared default"
												searchable
												disabled={disabled()}
												onChange={(v) => changeDefault(v === "inherit" ? "" : v)}
											/>
										}
									/>
									<Row
										title="Shared default thinking"
										meta="Per-model thinking settings and scope pins stay intact. Supported levels and each action's effective value appear below."
										wrap
										trailing={
											<Picker
												testID="models-thinking"
												label="Shared default thinking"
												items={[
													{ value: "inherit", title: "Keep action-specific defaults" },
													...THINKING.map((v) => ({ value: v, title: v })),
												]}
												value={draft()?.defaultThinkingLevel ?? "inherit"}
												placeholder="Thinking"
												disabled={disabled()}
												onChange={(v) => {
													const d = draft();
													if (d) draft.set({ ...d, defaultThinkingLevel: v === "inherit" ? null : v });
												}}
											/>
										}
									/>
									<Block>
										<Field
											label="Replacement price limit ($/M input + output)"
											testID="models-limit"
											value={replacement()}
											placeholder="Required only without reference prices"
											onChange={replacement.set}
										/>
									</Block>
								</If>
								<Row
									title="Chosen models"
									meta={
										read().scope.enabledModels?.length
											? read().scope.enabledModels?.join(", ")
											: "All authenticated models"
									}
									wrap
									trailing={
										<Button
											small
											label="Edit list"
											testID="models-edit-scope"
											disabled={disabled() || edit() !== null}
											onPress={() => {
												modelEditBinding.set(read().binding);
												modelEditProject.set(read().project?.id ?? "");
												patterns.set([...(read().scope.enabledModels ?? [])]);
												edit.set("scope");
											}}
										/>
									}
								/>
								<Each of={read().scope.resolution.filter((r) => r.matches.length === 0)} key={(r) => r.pattern}>
									{(r) => (
										<Row
											mark="needs"
											title={`${r().pattern}: unavailable (${r().unresolved ?? "unknown"}).`}
											meta="Sign in or choose another model."
										/>
									)}
								</Each>
								<If when={edit() === "scope"}>
									<Each
										of={patterns().map((pattern, index) => ({ pattern, index }))}
										key={(p) => String(p.index)}
									>
										{(p) => (
											<Row
												title={p().pattern}
												trailing={
													<Button
														small
														label="Remove"
														disabled={disabled()}
														onPress={() =>
															patterns.set(patterns().filter((_, index) => index !== p().index))
														}
													/>
												}
											/>
										)}
									</Each>
									<Row
										title="Add a model to the chosen list"
										trailing={
											<Picker
												label="Add a model to the chosen list"
												items={read().scope.candidates.map((m) => ({
													value: m.id,
													title: `${m.name} (${m.provider})`,
												}))}
												value={null}
												placeholder="Add a model"
												searchable
												disabled={disabled()}
												onChange={(v) => {
													if (!patterns().includes(v)) patterns.set([...patterns(), v]);
												}}
											/>
										}
									/>
								</If>
							</Rows>
							<If when={edit()}>
								<If
									when={
										modelEditProject() === (read().project?.id ?? "") && modelEditBinding() !== read().binding
									}
								>
									<Notice
										kind="needs"
										placement="section"
										text="AI settings changed. Your edits are kept."
										detail={`Saved now: ${edit() === "defaults" ? JSON.stringify(read().defaults) : JSON.stringify(read().scope.enabledModels)}`}
										action={
											<Link
												label="Keep my edits"
												disabled={disabled()}
												onPress={() => modelEditBinding.set(read().binding)}
											/>
										}
									/>
								</If>
								<If when={modelEditProject() !== (read().project?.id ?? "")}>
									<Notice
										kind="needs"
										placement="section"
										text="These edits belong to another project. Revert them before editing this project's settings."
									/>
								</If>
								<Block>
									<Buttons>
										<Button
											kind="primary"
											label="Save AI settings"
											testID="models-save"
											disabled={
												disabled() ||
												modelEditProject() !== (read().project?.id ?? "") ||
												(edit() === "scope" && patterns().length === 0)
											}
											onPress={() => void save()}
										/>
										<Button label="Revert" disabled={c.busy()} onPress={() => edit.set(null)} />
										<If when={edit() === "scope"}>
											<Button
												label="Use all authenticated models"
												disabled={disabled()}
												onPress={() =>
													void c.write("scope", null, modelEditBinding()).then((ok) => {
														if (ok) edit.set(null);
													})
												}
											/>
										</If>
									</Buttons>
								</Block>
							</If>
						</Section>
						<If when={read().project}>
							<Section
								title="Eligible models and thinking"
								count={read().task.models.length}
								footnote={
									read().task.models.length > 5
										? `First 5 of ${read().task.models.length} eligible models. Search the model pickers for the full list.`
										: undefined
								}
							>
								<If when={read().task.models.length === 0}>
									<EmptyLine text="No eligible model for new tasks. Check sign-in, chosen scope and the price ceiling." />
								</If>
								<Rows>
									<Each of={read().task.models.slice(0, 5)} key={(m) => m.id}>
										{(m) => (
											<Row
												title={`${m().name} (${m().id})`}
												meta={`Supported: ${m().thinkingLevels?.join(", ") ?? "not reported"}. Task: ${m().taskDefaultThinking ?? "not reported"}. Build: ${m().defaultThinking ?? "not reported"}. Switch: ${m().modelChangeThinking ?? "keep current thinking"}.`}
												wrap
											/>
										)}
									</Each>
								</Rows>
							</Section>
						</If>
						<If when={(read().failed?.length ?? 0) > 0}>
							<Section
								title="Failed work"
								count={read().failedCount ?? 0}
								footnote={`Showing ${read().failed?.length ?? 0} of ${read().failedCount ?? 0} failed chats. Other work keeps its own controls.`}
							>
								<Rows>
									<Each of={read().failed ?? []} key={(f) => f.id}>
										{(f) => <FailedWork controls={c} id={f().id} title={f().title} />}
									</Each>
								</Rows>
							</Section>
						</If>
						<Section title="Provider sign-in">
							<Block>
								<Caption tone="faint">
									Sign-in codes stay out of chats and saved drafts. Sign out removes Pilot's stored credential,
									not environment keys or the provider's own authorization.
								</Caption>
							</Block>
							<Rows>
								<Each
									of={read().providers.filter((p) => p.methods.length > 0 || p.credential !== "missing")}
									key={(p) => p.id}
								>
									{(p) => (
										<Row
											title={p().name}
											meta={p().credential.replaceAll("_", " ")}
											detail={
												<RowDetail>
													<Buttons>
														<Each of={p().methods} key={(m) => m}>
															{(m) => (
																<Button
																	small
																	label={
																		m() === "device_code"
																			? "Sign in with device code"
																			: "Sign in with browser code"
																	}
																	disabled={
																		disabled() ||
																		read().runs.some(
																			(r) =>
																				r.provider === p().id &&
																				["starting", "waiting", "working"].includes(r.state),
																		)
																	}
																	onPress={() => {
																		challenge.set(null);
																		answer.set("");
																		void c.write("sign-in", { provider: p().id, method: m() });
																	}}
																/>
															)}
														</Each>
														<Button
															small
															label="Sign out"
															disabled={c.busy()}
															onPress={() => logout.set(p().id)}
														/>
													</Buttons>
													<If when={logout() === p().id}>
														<Caption>
															This cancels pending sign-in and removes this provider's stored credential.
															Affected work may need sign-in again.
														</Caption>
														<Buttons>
															<Button
																small
																kind="destructive"
																label="Confirm sign out"
																disabled={c.busy()}
																onPress={() => {
																	challenge.set(null);
																	answer.set("");
																	void c.write("logout", p().id).then((ok) => {
																		if (ok) logout.set(null);
																	});
																}}
															/>
															<Button small label="Keep signed in" onPress={() => logout.set(null)} />
														</Buttons>
													</If>
												</RowDetail>
											}
										/>
									)}
								</Each>
								<Each of={read().runs} key={(r) => r.id}>
									{(r) => (
										<Row
											title={`${r().provider}: ${r().state}${r().reauthenticationRequired ? ", fresh sign-in required" : ""}`}
											trailing={
												<>
													<Button
														small
														label="Check sign-in"
														disabled={c.busy()}
														onPress={() => void checkRun(r().id)}
													/>
													<If when={["starting", "waiting", "working"].includes(r().state)}>
														<Button
															small
															label="Cancel sign-in"
															disabled={c.busy()}
															onPress={() => {
																challenge.set(null);
																answer.set("");
																void c.write("cancel", r().id);
															}}
														/>
													</If>
												</>
											}
										/>
									)}
								</Each>
							</Rows>
							<If when={challenge()?.challenge}>
								<Block testID="models-sign-in" gap={3}>
									<Body>Complete this sign-in with your provider.</Body>
									<Quote code text={challenge()?.challenge?.userCode ?? ""} />
									<Buttons>
										<Button
											label="Open sign-in page"
											disabled={c.busy()}
											onPress={() => {
												const v = challenge();
												if (v) void c.signIn(v.run.id, "open");
											}}
										/>
									</Buttons>
									<If when={challenge()?.challenge?.type === "manual_code"}>
										<Field
											label="Provider response (code#state)"
											masked
											testID="models-answer"
											value={answer()}
											placeholder="Paste the complete response"
											onChange={answer.set}
										/>
										<Buttons>
											<Button
												label="Send sign-in response"
												disabled={c.busy() || !answer().trim()}
												onPress={() => {
													const v = challenge();
													const text = answer();
													answer.set("");
													challenge.set(null);
													if (v?.challenge) void c.signIn(v.run.id, "answer", v.challenge.id, text);
												}}
											/>
										</Buttons>
									</If>
								</Block>
							</If>
						</Section>
					</>
				)}
			</If>
		</View>
	);
}
