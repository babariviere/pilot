// Native privacy controls and explicit entry to an on-demand read-only specialist.
import { signal, Text, View } from "nsh";
import { openChat } from "./chatView";
import type { DiagnosisControls, Privacy } from "./diagnosisControls";
import {
	diagnosisModel,
	diagnosisQuestion,
	diagnosisReplies,
	diagnosisThinking,
	privacyDraft,
	safeCollector,
} from "./diagnosisDraft";
import { keepField } from "./kept";
import { OpenChatAction } from "./OpenChatAction";
import { utf8Bytes } from "./preferencesFeed";
import { Action, Field, Panel, Picker, SectionTitle, TextField } from "./ui";

function PrivacyRow(props: {
	label: string;
	detail: string;
	value: boolean;
	disabled: boolean;
	onChange: () => void;
	testID: string;
}) {
	return (
		<View class="flex-row items-center gap-4 border-t border-border py-3">
			<View class="flex-1 gap-1">
				<Text class="text-sm font-medium text-foreground">{props.label}</Text>
				<Text class="text-sm text-muted-foreground">{props.detail}</Text>
			</View>
			<Action
				label={props.value ? "On · turn off" : "Off · turn on"}
				testID={props.testID}
				accessibilityLabel={`${props.label}: ${props.value ? "on, turn off" : "off, turn on"}`}
				disabled={props.disabled}
				onPress={props.onChange}
			/>
		</View>
	);
}
export function DiagnosisStatus(props: { controls: DiagnosisControls }) {
	return (
		<View class="gap-2">
			<If when={props.controls.message()}>
				<Text testID="diagnosis-message" class="text-sm text-muted-foreground">
					{props.controls.message()}
				</Text>
			</If>
			<Each of={props.controls.operations().filter((o) => o.pending)} key={(o) => o.operationId}>
				{(o) => (
					<View class="flex-row items-center gap-3">
						<Text class="flex-1 text-sm text-muted-foreground">
							Unconfirmed diagnostics action. Do not send it again.
						</Text>
						<Action
							label="Check receipt"
							testID="diagnosis-check"
							disabled={props.controls.busy()}
							onPress={() => void props.controls.check(o().operationId)}
						/>
					</View>
				)}
			</Each>
		</View>
	);
}
export function DiagnosisSettings(props: { controls: DiagnosisControls }) {
	const c = props.controls;
	void c.read();
	const questionField = keepField("diagnosis-question", () => "settings", diagnosisQuestion);
	const details = signal(false),
		clearing = signal(false),
		asking = signal(false),
		all = signal(false);
	const s = () => c.snapshot();
	const pending = () => c.operations().some((o) => o.pending);
	const disabled = () => c.busy() || pending() || !s()?.binding;
	const value = () => privacyDraft() ?? s()?.settings;
	const edit = (key: keyof Privacy, v: boolean | string) => {
		const current = s();
		if (!current || disabled()) return;
		privacyDraft.set({
			...current.settings,
			endpoint: current.settings.endpoint ?? "",
			binding: current.binding,
			...privacyDraft(),
			[key]: v,
		});
	};
	const stale = () => !!privacyDraft() && privacyDraft()?.binding !== s()?.binding;
	const save = async () => {
		const d = privacyDraft();
		if (!d || disabled() || stale()) return;
		const { binding, endpoint, ...bits } = d;
		const r = await c.write("save", { ...bits, ...(endpoint ? { endpoint } : {}) }, binding);
		if (r.accepted && privacyDraft() === d) privacyDraft.set(null);
	};
	const model = () => s()?.models.find((m) => m.id === diagnosisModel());
	const begin = async () => {
		const question = diagnosisQuestion();
		const r = await c.write("start", { model: diagnosisModel(), thinking: diagnosisThinking(), question });
		if (r.accepted && r.sessionId) {
			if (diagnosisQuestion() === question) diagnosisQuestion.set("");
			asking.set(false);
			openChat(r.sessionId, "Settings");
		}
	};
	return (
		<View testID="diagnosis-settings" class="gap-5">
			<View class="gap-1.5">
				<SectionTitle title="Diagnostics & privacy" />
				<Text class="text-sm text-muted-foreground">
					This Mac and its connected service. Local collection never enables uploads.
				</Text>
			</View>
			<Action
				label={c.busy() ? "Reading…" : "Read again"}
				testID="diagnosis-read"
				disabled={c.busy()}
				onPress={() => void c.read()}
			/>
			<If when={s()}>
				<View>
					<PrivacyRow
						label="Local operational diagnostics"
						detail="Protected rotating app and service evidence. Structured records exclude conversation content."
						value={value()?.localDiagnostics === true}
						disabled={disabled()}
						testID="privacy-local"
						onChange={() => edit("localDiagnostics", !value()?.localDiagnostics)}
					/>
					<PrivacyRow
						label="Local feature counts"
						detail="Optional daily counts of catalogued actions, without chat text or project names. Stored on this Mac, not uploaded."
						value={value()?.localFeatureUsage === true}
						disabled={disabled()}
						testID="privacy-counts"
						onChange={() => edit("localFeatureUsage", !value()?.localFeatureUsage)}
					/>
					<PrivacyRow
						label="Remote operational reporting"
						detail="Separate opt-in. Sends reviewed operational fields to your collector, not raw logs or conversation content."
						value={value()?.remoteOperational === true}
						disabled={disabled()}
						testID="privacy-remote"
						onChange={() => edit("remoteOperational", !value()?.remoteOperational)}
					/>
					<If when={value()?.remoteOperational || privacyDraft()?.endpoint}>
						<Field
							label="Collector endpoint"
							testID="privacy-endpoint"
							value={value()?.endpoint ?? ""}
							placeholder="https://collector.example.test/v1/traces"
							onChange={(v) => edit("endpoint", v)}
						/>
						<Text class="text-xs text-muted-foreground">
							HTTPS or literal loopback HTTP, with no credentials, query or custom path. Your collector controls
							its own retention. No offline upload queue.
						</Text>
					</If>
					<PrivacyRow
						label="Product analytics"
						detail="Separate consent for catalogued product events. Export also requires remote reporting. Local feature-count history is never uploaded."
						value={value()?.productAnalytics === true}
						disabled={disabled()}
						testID="privacy-analytics"
						onChange={() => edit("productAnalytics", !value()?.productAnalytics)}
					/>
				</View>
				<If when={privacyDraft()}>
					<Text class="text-sm text-muted-foreground">Not saved. Save applies only these privacy controls.</Text>
					<If when={stale()}>
						<Text class="text-sm text-needs-ink">
							These controls changed since you edited them. Revert to the current choices before editing again.
						</Text>
					</If>
					<If when={!!privacyDraft()?.endpoint && !safeCollector(privacyDraft()?.endpoint ?? "")}>
						<Text class="text-sm text-needs-ink">
							Use a collector endpoint without credentials or a custom path. This invalid endpoint will not be
							saved in your window draft.
						</Text>
					</If>
					<View class="flex-row gap-2">
						<Action label="Revert" disabled={c.busy()} onPress={() => privacyDraft.set(null)} />
						<Action
							label="Save privacy controls"
							testID="privacy-save"
							variant="primary"
							disabled={
								disabled() ||
								stale() ||
								(!!privacyDraft()?.endpoint && !safeCollector(privacyDraft()?.endpoint ?? "")) ||
								(value()?.remoteOperational === true && !value()?.endpoint)
							}
							onPress={() => void save()}
						/>
					</View>
				</If>
				<View class="gap-3 border-t border-border pt-3">
					<Action
						label={details() ? "Hide retention details" : "Retention & other copies"}
						testID="privacy-details"
						onPress={() => details.set(!details())}
					/>
					<If when={details()}>
						<View class="gap-2">
							<Text class="text-sm text-muted-foreground">
								Managed Day logs rotate at 1 MiB and keep three older segments. Startup before verified controls
								is not recorded. Disable stops this writer; it does not delete its existing files. Reads filter
								disabled or old-epoch evidence.
							</Text>
							<Each of={s()?.retained ?? []} key={(x) => x}>
								{(line) => <Text class="text-sm text-muted-foreground">{line()}</Text>}
							</Each>
							<Text class="text-sm text-muted-foreground">
								This app can confirm only its own writer. Other app processes, backups and OS-held stdout may
								keep copies. Unknown or disconnected writer controls stop integrated collection; they do not
								prove physical deletion.
							</Text>
						</View>
					</If>
					<Action
						label="Clear local diagnostics…"
						testID="privacy-clear"
						disabled={disabled()}
						onPress={() => clearing.set(true)}
					/>
					<If when={clearing()}>
						<Panel size="lg" class="gap-3">
							<Text class="text-sm font-medium text-foreground">Clear managed local evidence?</Text>
							<Text class="text-sm text-muted-foreground">
								Deletes managed service evidence, local feature counts and this app writer's log segments.
								Collection can write new records while enabled. OS logs, agent replies, exports, backups, other
								app writers and uploaded data remain. Writer results are reported separately.
							</Text>
							<View class="flex-row gap-2">
								<Action label="Cancel" onPress={() => clearing.set(false)} />
								<Action
									label="Clear local evidence"
									testID="privacy-clear-confirm"
									disabled={disabled()}
									onPress={() => {
										clearing.set(false);
										void c.write("clear", null);
									}}
								/>
							</View>
						</Panel>
					</If>
				</View>
			</If>
			<Action
				label="Turn off all collection and reporting"
				testID="privacy-revoke"
				disabled={c.busy()}
				onPress={() =>
					void c
						.write("save", {
							localDiagnostics: false,
							localFeatureUsage: false,
							remoteOperational: false,
							productAnalytics: false,
						})
						.then((r) => {
							if (r.accepted) privacyDraft.set(null);
						})
				}
			/>
			<Text class="text-xs text-muted-foreground">
				Revocation stays available when an earlier action is unconfirmed. It does not clear kept copies or replay
				that action.
			</Text>
			<DiagnosisStatus controls={c} />
			<View class="gap-3 border-t border-border pt-5">
				<SectionTitle title="Investigate a problem" />
				<Text class="text-sm text-muted-foreground">
					Ask a read-only specialist. No continuous AI monitor. Fixing code is a separate action.
				</Text>
				<Action
					label="Ask about Pilot"
					testID="diagnosis-ask"
					variant="primary"
					disabled={disabled()}
					onPress={() => asking.set(!asking())}
				/>
				<If when={asking()}>
					<View class="gap-3">
						<Text class="text-sm text-muted-foreground">
							Focus: no chat, app-wide on this service. The specialist can read protected Pilot logs, chat
							history and operational evidence across this service. It cannot change work, enable collection or
							start a fix.
						</Text>
						<Text class="text-sm text-muted-foreground">
							Your question and the evidence it reads go to the selected model provider. This is separate from
							telemetry consent.
						</Text>
						<Picker
							label="Diagnosis model"
							testID="diagnosis-model"
							items={(s()?.models ?? []).map((m) => ({ value: m.id, title: `${m.name} (${m.id})` }))}
							value={diagnosisModel() || null}
							placeholder="Choose an eligible model"
							disabled={disabled()}
							onChange={(id) => {
								diagnosisModel.set(id);
								diagnosisThinking.set(s()?.models.find((m) => m.id === id)?.taskDefaultThinking ?? "");
							}}
						/>
						<Picker
							label="Diagnosis thinking"
							testID="diagnosis-thinking"
							items={(model()?.thinkingLevels ?? []).map((level) => ({ value: level, title: level }))}
							value={diagnosisThinking() || null}
							placeholder="Choose supported thinking"
							disabled={disabled()}
							onChange={diagnosisThinking.set}
						/>
						<TextField
							ref={questionField.ref}
							onFocus={questionField.focus}
							onSelectionChange={questionField.select}
							testID="diagnosis-question"
							accessibilityLabel="What should we investigate?"
							multiline
							value={diagnosisQuestion()}
							onChange={({ value }) => diagnosisQuestion.set(value)}
							placeholder="What should we investigate?"
							rows={4}
						/>
						<Action
							label="Start diagnosis"
							testID="diagnosis-start"
							variant="primary"
							disabled={
								disabled() ||
								!model() ||
								!(model()?.thinkingLevels ?? []).includes(diagnosisThinking()) ||
								!diagnosisQuestion().trim() ||
								utf8Bytes(diagnosisQuestion()) > 8192
							}
							onPress={() => void begin()}
						/>
					</View>
				</If>
				<Each of={(s()?.chats.items ?? []).slice(0, all() ? 100 : 5)} key={(c) => c.sessionId}>
					{(chat) => (
						<View class="flex-row items-start gap-3 border-t border-border py-2">
							<Text class="min-w-0 flex-1 text-sm text-foreground">{chat().title || "Pilot diagnostics"}</Text>
							<Text class="text-xs text-muted-foreground">{chat().status}</Text>
							<OpenChatAction
								label="Open diagnosis chat"
								accessibilityLabel="Open diagnosis chat"
								onPress={() => openChat(chat().sessionId, "Settings")}
							/>
						</View>
					)}
				</Each>
				<If when={(s()?.chats.items.length ?? 0) > 5}>
					<Action label={all() ? "Show fewer" : "Show saved diagnoses"} onPress={() => all.set(!all())} />
				</If>
				<If when={s()?.chats.hasMore}>
					<Text class="text-sm text-muted-foreground">
						Only the first 100 active app-wide diagnoses are listed.
					</Text>
				</If>
			</View>
		</View>
	);
}
export function DiagnosisReply(props: { controls: DiagnosisControls; sessionId: string }) {
	const c = props.controls;
	void c.read();
	const text = () => diagnosisReplies()[props.sessionId] ?? "";
	const replyField = keepField(`diagnosis-reply-${props.sessionId}`, () => "chat", text);
	const send = async () => {
		const message = text();
		const r = await c.write("send", { sessionId: props.sessionId, message });
		if (r.accepted && text() === message) diagnosisReplies.set({ ...diagnosisReplies(), [props.sessionId]: "" });
	};
	return (
		<View class="gap-3 border-t border-border pt-4">
			<Text class="text-sm text-muted-foreground">
				Ask a follow-up. This specialist is read-only; a fix needs a separate start.
			</Text>
			<TextField
				ref={replyField.ref}
				onFocus={replyField.focus}
				onSelectionChange={replyField.select}
				testID="diagnosis-reply"
				accessibilityLabel="Follow-up question"
				multiline
				value={text()}
				onChange={({ value }) => diagnosisReplies.set({ ...diagnosisReplies(), [props.sessionId]: value })}
				rows={4}
			/>
			<View class="flex-row gap-2">
				<Action label="Read controls again" disabled={c.busy()} onPress={() => void c.read()} />
				<Action
					label="Send follow-up"
					testID="diagnosis-send"
					variant="primary"
					disabled={
						c.busy() ||
						!c.snapshot() ||
						c.operations().some((o) => o.pending) ||
						!text().trim() ||
						utf8Bytes(text()) > 8192
					}
					onPress={() => void send()}
				/>
			</View>
			<DiagnosisStatus controls={c} />
		</View>
	);
}
