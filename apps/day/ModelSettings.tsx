// AI settings use the page's existing reading column, quiet rows and native controls.
// Sign-in challenges and answers are ephemeral, never part of saved drafts or messages.
import { effect, signal, Text, untracked, View } from "nsh";
import type { ModelControls, ModelRecovery, ModelSettings, SignInView } from "./modelControls";
import {
	modelDraft as draft,
	modelEdit as edit,
	modelEditBinding,
	modelEditProject,
	modelPatterns as patterns,
	modelReplacement as replacement,
} from "./modelSettingsDraft";
import { Action, Field, Picker, SectionTitle } from "./ui";

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
		<View class="gap-2 border-t border-border pt-3">
			<Text class="text-sm text-foreground">{props.title}</Text>
			<Text class="text-xs text-faint">
				Only this chat is affected. Choosing a model saves it for an explicit next attempt; it does not restart
				work.
			</Text>
			<Action
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
			<If when={read()}>
				{(r) => (
					<View class="gap-2">
						<If when={r().choices.models.length === 0}>
							<Text class="text-sm text-needs-ink">
								No eligible replacement for this chat. Check sign-in, its scope and the price ceiling.
							</Text>
						</If>
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
						<Action
							label="Save for next attempt"
							disabled={props.controls.busy() || props.controls.unknown().length > 0 || !choice() || !thinking()}
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
					</View>
				)}
			</If>
		</View>
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
		<View testID="model-settings" class="gap-4">
			<View class="gap-1.5">
				<SectionTitle title="AI" />
				<Text class="text-sm text-muted-foreground">
					Choose models for new work. Running chats keep their current model. Advanced Pi configuration stays
					unchanged.
				</Text>
			</View>
			<View class="flex-row items-center gap-3">
				<Text class="flex-1 text-sm text-muted-foreground">
					{s()?.project ? `Project: ${s()?.project?.name}` : "Shared settings for all projects"}
				</Text>
				<Action
					label={c.busy() ? "Reading…" : "Read again"}
					testID="models-read"
					disabled={c.busy()}
					onPress={() => void c.read()}
				/>
			</View>
			<If when={c.message()}>
				<Text testID="models-message" class="text-sm text-needs-ink">
					{c.message()}
				</Text>
			</If>
			<Each of={c.unknown()} key={(o) => o.operationId}>
				{(o) => (
					<View class="flex-row items-center gap-2">
						<Text class="flex-1 text-sm text-muted-foreground">
							An earlier AI settings action is Unknown. No automatic retry.
						</Text>
						<Action
							label="Check receipt"
							testID="models-check"
							disabled={c.busy()}
							onPress={() => void c.check(o().operationId)}
						/>
					</View>
				)}
			</Each>
			<If when={s()}>
				{(read) => (
					<View class="gap-4">
						<If
							when={read().project}
							else={
								<Text class="text-sm text-muted-foreground">
									Choose a project in Today to see its effective model, thinking and price ceiling. Shared
									settings and sign-in stay available below.
								</Text>
							}
						>
							<View class="gap-2 border-t border-border pt-3">
								<Text class="text-sm font-medium text-foreground">Effective choices</Text>
								<Text
									testID="models-effective-task"
									class="text-sm text-muted-foreground"
								>{`Mission/task start: ${effective(read(), true)}`}</Text>
								<Text
									testID="models-effective-build"
									class="text-sm text-muted-foreground"
								>{`Fresh Build: ${effective(read(), false)}`}</Text>
								<Text class="text-xs text-faint">
									Prepared copies, Ask profiles and existing chats can differ. A running chat's reported choice
									is authoritative.
								</Text>
								<Text testID="models-price" class="text-sm text-muted-foreground">
									{read().task.priceCeiling?.limit != null
										? `Task-start ceiling: $${read().task.priceCeiling?.limit}/M input + output (${read().task.priceCeiling?.source}).`
										: "Reference prices unavailable. New task starts are held until you set a replacement limit."}
								</Text>
							</View>
						</If>
						<If when={read().project}>
							<View class="gap-2 border-t border-border pt-3">
								<Text class="text-sm text-foreground">Project model override</Text>
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
								<Text class="text-xs text-faint">{`Pi project scope: ${read().scope.projectOverride === null ? "inherits shared scope" : JSON.stringify(read().scope.projectOverride)}. Pi project defaults may override shared defaults.`}</Text>
							</View>
						</If>
						<View class="gap-2 border-t border-border pt-3">
							<View class="flex-row items-center">
								<Text class="flex-1 text-sm text-foreground">Shared defaults</Text>
								<Action
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
							</View>
							<Text class="text-sm text-muted-foreground">
								{read().defaults.defaultModel
									? `${read().defaults.defaultProvider ?? ""}/${read().defaults.defaultModel}`
									: "Pi chooses the default"}
							</Text>
							<If when={edit() === "defaults"}>
								<Picker
									testID="models-default"
									label="Shared default model"
									items={[
										{ value: "inherit", title: "Let Pi choose" },
										...read().scope.candidates.map((m) => ({ value: m.id, title: m.name })),
									]}
									value={
										draft()?.defaultModel ? `${draft()?.defaultProvider}/${draft()?.defaultModel}` : "inherit"
									}
									placeholder="Choose a shared default"
									searchable
									disabled={disabled()}
									onChange={(v) => changeDefault(v === "inherit" ? "" : v)}
								/>
								<Picker
									testID="models-thinking"
									label="Shared default thinking"
									items={[
										{ value: "inherit", title: "Keep action-specific defaults" },
										...["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((v) => ({
											value: v,
											title: v,
										})),
									]}
									value={draft()?.defaultThinkingLevel ?? "inherit"}
									placeholder="Thinking"
									disabled={disabled()}
									onChange={(v) => {
										const d = draft();
										if (d) draft.set({ ...d, defaultThinkingLevel: v === "inherit" ? null : v });
									}}
								/>
								<Text class="text-xs text-faint">
									Per-model thinking settings and scope pins stay intact. Supported levels and each action's
									effective value appear below.
								</Text>
								<Field
									label="Replacement price limit ($/M input + output)"
									testID="models-limit"
									value={replacement()}
									placeholder="Required only without reference prices"
									onChange={replacement.set}
								/>
							</If>
						</View>
						<View class="gap-2 border-t border-border pt-3">
							<View class="flex-row items-center">
								<Text class="flex-1 text-sm text-foreground">Chosen models</Text>
								<Action
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
							</View>
							<Text class="text-sm text-muted-foreground">
								{read().scope.enabledModels?.length
									? read().scope.enabledModels?.join(", ")
									: "All authenticated models"}
							</Text>
							<Each of={read().scope.resolution.filter((r) => r.matches.length === 0)} key={(r) => r.pattern}>
								{(r) => (
									<Text class="text-xs text-needs-ink">{`${r().pattern}: unavailable (${r().unresolved ?? "unknown"}). Sign in or choose another model.`}</Text>
								)}
							</Each>
							<If when={edit() === "scope"}>
								<Each
									of={patterns().map((pattern, index) => ({ pattern, index }))}
									key={(p) => String(p.index)}
								>
									{(p) => (
										<View class="flex-row items-center">
											<Text class="flex-1 text-sm text-muted-foreground">{p().pattern}</Text>
											<Action
												label="Remove"
												disabled={disabled()}
												onPress={() => patterns.set(patterns().filter((_, index) => index !== p().index))}
											/>
										</View>
									)}
								</Each>
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
								<Action
									label="Use all authenticated models"
									disabled={disabled()}
									onPress={() =>
										void c.write("scope", null, modelEditBinding()).then((ok) => {
											if (ok) edit.set(null);
										})
									}
								/>
							</If>
						</View>
						<If when={edit()}>
							<If
								when={
									modelEditProject() === (read().project?.id ?? "") && modelEditBinding() !== read().binding
								}
							>
								<View class="gap-2 rounded-lg bg-muted p-3">
									<Text class="text-sm text-foreground">AI settings changed. Your edits are kept.</Text>
									<Text class="text-xs text-faint">{`Saved now: ${edit() === "defaults" ? JSON.stringify(read().defaults) : JSON.stringify(read().scope.enabledModels)}`}</Text>
									<Action
										label="Keep my edits"
										disabled={disabled()}
										onPress={() => modelEditBinding.set(read().binding)}
									/>
								</View>
							</If>
							<View class="flex-row gap-2">
								<If when={modelEditProject() !== (read().project?.id ?? "")}>
									<Text class="text-sm text-needs-ink">
										These edits belong to another project. Revert them before editing this project's settings.
									</Text>
								</If>
								<Action
									primary
									label="Save AI settings"
									testID="models-save"
									disabled={
										disabled() ||
										modelEditProject() !== (read().project?.id ?? "") ||
										(edit() === "scope" && patterns().length === 0)
									}
									onPress={() => void save()}
								/>
								<Action label="Revert" disabled={c.busy()} onPress={() => edit.set(null)} />
							</View>
						</If>
						<If when={read().project}>
							<View class="gap-2 border-t border-border pt-3">
								<Text class="text-sm font-medium text-foreground">Eligible models and thinking</Text>
								<If when={read().task.models.length === 0}>
									<Text class="text-sm text-muted-foreground">
										No eligible model for new tasks. Check sign-in, chosen scope and the price ceiling.
									</Text>
								</If>
								<If when={read().task.models.length > 5}>
									<Text class="text-xs text-faint">{`First 5 of ${read().task.models.length} eligible models. Search the model pickers for the full list.`}</Text>
								</If>
								<Each of={read().task.models.slice(0, 5)} key={(m) => m.id}>
									{(m) => (
										<View class="gap-1 py-1">
											<Text class="text-sm text-foreground">{`${m().name} (${m().id})`}</Text>
											<Text class="text-xs text-faint">{`Supported: ${m().thinkingLevels?.join(", ") ?? "not reported"}. Task: ${m().taskDefaultThinking ?? "not reported"}. Build: ${m().defaultThinking ?? "not reported"}. Switch: ${m().modelChangeThinking ?? "keep current thinking"}.`}</Text>
										</View>
									)}
								</Each>
							</View>
						</If>
						<If when={(read().failed?.length ?? 0) > 0}>
							<View class="gap-2">
								<SectionTitle title="Failed work" />
								<Text class="text-xs text-faint">{`Showing ${read().failed?.length ?? 0} of ${read().failedCount ?? 0} failed chats. Other work keeps its own controls.`}</Text>
								<Each of={read().failed ?? []} key={(f) => f.id}>
									{(f) => <FailedWork controls={c} id={f().id} title={f().title} />}
								</Each>
							</View>
						</If>
						<View class="gap-3 border-t border-border pt-3">
							<SectionTitle title="Provider sign-in" />
							<Text class="text-xs text-faint">
								Sign-in codes stay out of chats and saved drafts. Sign out removes Pilot's stored credential,
								not environment keys or the provider's own authorization.
							</Text>
							<Each
								of={read().providers.filter((p) => p.methods.length > 0 || p.credential !== "missing")}
								key={(p) => p.id}
							>
								{(p) => (
									<View class="gap-2 border-t border-border pt-3">
										<Text class="text-sm text-foreground">{`${p().name}: ${p().credential.replaceAll("_", " ")}`}</Text>
										<View class="flex-row flex-wrap gap-2">
											<Each of={p().methods} key={(m) => m}>
												{(m) => (
													<Action
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
											<Action label="Sign out" disabled={c.busy()} onPress={() => logout.set(p().id)} />
										</View>
										<If when={logout() === p().id}>
											<View class="gap-2">
												<Text class="text-sm text-muted-foreground">
													This cancels pending sign-in and removes this provider's stored credential.
													Affected work may need sign-in again.
												</Text>
												<View class="flex-row">
													<Action
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
													<Action label="Keep signed in" onPress={() => logout.set(null)} />
												</View>
											</View>
										</If>
									</View>
								)}
							</Each>
							<Each of={read().runs} key={(r) => r.id}>
								{(r) => (
									<View class="gap-2">
										<Text class="text-sm text-muted-foreground">{`${r().provider}: ${r().state}${r().reauthenticationRequired ? ", fresh sign-in required" : ""}`}</Text>
										<View class="flex-row">
											<Action
												label="Check sign-in"
												disabled={c.busy()}
												onPress={() => void checkRun(r().id)}
											/>
											<If when={["starting", "waiting", "working"].includes(r().state)}>
												<Action
													label="Cancel sign-in"
													disabled={c.busy()}
													onPress={() => {
														challenge.set(null);
														answer.set("");
														void c.write("cancel", r().id);
													}}
												/>
											</If>
										</View>
									</View>
								)}
							</Each>
							<If when={challenge()?.challenge}>
								<View testID="models-sign-in" class="gap-2 rounded-xl bg-muted p-4">
									<Text class="text-sm text-foreground">Complete this sign-in with your provider.</Text>
									<View selectable>
										<Text class="text-sm text-foreground">{challenge()?.challenge?.userCode ?? ""}</Text>
									</View>
									<Action
										label="Open sign-in page"
										disabled={c.busy()}
										onPress={() => {
											const v = challenge();
											if (v) void c.signIn(v.run.id, "open");
										}}
									/>
									<If when={challenge()?.challenge?.type === "manual_code"}>
										<Field
											label="Provider response (code#state)"
											masked
											testID="models-answer"
											value={answer()}
											placeholder="Paste the complete response"
											onChange={answer.set}
										/>
										<Action
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
									</If>
								</View>
							</If>
						</View>
					</View>
				)}
			</If>
		</View>
	);
}
