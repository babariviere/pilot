// Native privacy controls and explicit entry to an on-demand read-only specialist, in Settings' Diagnostics &
// privacy tab. Privacy switches change a draft; only Save sends it. Clearing local evidence asks first.
import { signal, View } from "nsh";
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
import { keepRead } from "./freshness";
import { keepField } from "./kept";
import { OpenChatAction } from "./OpenChatAction";
import { utf8Bytes } from "./preferencesFeed";
import {
	Block,
	Body,
	Button,
	Buttons,
	Caption,
	Disclosure,
	Field,
	Link,
	Notice,
	Picker,
	Question,
	Row,
	Rows,
	Section,
	Switch,
	TextField,
} from "./ui";

/** One privacy control: its name, what it does and its switch. The switch changes the draft; Save sends it. */
function PrivacyRow(props: {
	label: string;
	detail: string;
	value: boolean;
	disabled: boolean;
	onChange: () => void;
	testID: string;
}) {
	return (
		<Row
			title={props.label}
			meta={props.detail}
			wrap
			trailing={
				<Switch
					testID={props.testID}
					accessibilityLabel={props.label}
					checked={props.value}
					disabled={props.disabled}
					onChange={() => props.onChange()}
				/>
			}
		/>
	);
}

/** What the last diagnostics action said, and Check for each action whose answer was lost. */
export function DiagnosisStatus(props: { controls: DiagnosisControls }) {
	return (
		<>
			<If when={props.controls.message()}>
				<Block>
					<Caption testID="diagnosis-message">{props.controls.message()}</Caption>
				</Block>
			</If>
			<Each of={props.controls.operations().filter((o) => o.pending)} key={(o) => o.operationId}>
				{(o) => (
					<Notice
						kind="needs"
						placement="section"
						text="Unconfirmed diagnostics action. Do not send it again."
						action={
							<Link
								label="Check receipt"
								testID="diagnosis-check"
								disabled={props.controls.busy()}
								onPress={() => void props.controls.check(o().operationId)}
							/>
						}
					/>
				)}
			</Each>
		</>
	);
}

export function DiagnosisSettings(props: { controls: DiagnosisControls }) {
	const c = props.controls;
	void c.read();
	// Pilot reads again on its own after a failed read, and when the window comes back.
	const reads = keepRead(
		() => c.read(),
		() => c.readFailed?.() ?? false,
		() => !!c.snapshot(),
	);
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
		<View testID="diagnosis-settings">
			<Section
				title="Diagnostics & privacy"
				action={
					<If when={reads.warn()}>
						<Link
							label={c.busy() ? "Reading…" : "Try now"}
							testID="diagnosis-read"
							disabled={c.busy()}
							onPress={() => void reads.now()}
						/>
					</If>
				}
			>
				<Block>
					<Body tone="muted" measure>
						This Mac and its connected service. Local collection never enables uploads.
					</Body>
				</Block>
				<If when={s()}>
					<Rows>
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
							<Block>
								<Field
									label="Collector endpoint"
									testID="privacy-endpoint"
									value={value()?.endpoint ?? ""}
									placeholder="https://collector.example.test/v1/traces"
									help="HTTPS or literal loopback HTTP, with no credentials, query or custom path. Your collector controls its own retention. No offline upload queue."
									onChange={(v) => edit("endpoint", v)}
								/>
							</Block>
						</If>
						<PrivacyRow
							label="Product analytics"
							detail="Separate consent for catalogued product events. Export also requires remote reporting. Local feature-count history is never uploaded."
							value={value()?.productAnalytics === true}
							disabled={disabled()}
							testID="privacy-analytics"
							onChange={() => edit("productAnalytics", !value()?.productAnalytics)}
						/>
					</Rows>
					<If when={privacyDraft()}>
						<If when={stale()}>
							<Notice
								kind="needs"
								placement="section"
								text="These controls changed since you edited them. Revert to the current choices before editing again."
							/>
						</If>
						<If when={!!privacyDraft()?.endpoint && !safeCollector(privacyDraft()?.endpoint ?? "")}>
							<Notice
								kind="needs"
								placement="section"
								text="Use a collector endpoint without credentials or a custom path. This invalid endpoint will not be saved in your window draft."
							/>
						</If>
						<Block>
							<Caption>Not saved. Save applies only these privacy controls.</Caption>
							<Buttons>
								<Button
									kind="primary"
									label="Save privacy controls"
									testID="privacy-save"
									disabled={
										disabled() ||
										stale() ||
										(!!privacyDraft()?.endpoint && !safeCollector(privacyDraft()?.endpoint ?? "")) ||
										(value()?.remoteOperational === true && !value()?.endpoint)
									}
									onPress={() => void save()}
								/>
								<Button label="Revert" disabled={c.busy()} onPress={() => privacyDraft.set(null)} />
							</Buttons>
						</Block>
					</If>
				</If>
				<DiagnosisStatus controls={c} />
				<Block gap={3}>
					<Buttons>
						<Button
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
					</Buttons>
					<Caption>
						Revocation stays available when an earlier action is unconfirmed. It does not clear kept copies or
						replay that action.
					</Caption>
					<If when={s()}>
						<Disclosure
							label={details() ? "Hide retention details" : "Retention & other copies"}
							testID="privacy-details"
							open={details()}
							onToggle={() => details.set(!details())}
						>
							<View class="gap-2">
								<Body tone="muted" measure>
									Managed Day logs rotate at 1 MiB and keep three older segments. Startup before verified
									controls is not recorded. Disable stops this writer; it does not delete its existing files.
									Reads filter disabled or old-epoch evidence.
								</Body>
								<Each of={s()?.retained ?? []} key={(x) => x}>
									{(line) => (
										<Body tone="muted" measure>
											{line()}
										</Body>
									)}
								</Each>
								<Body tone="muted" measure>
									This app can confirm only its own writer. Other app processes, backups and OS-held stdout may
									keep copies. Unknown or disconnected writer controls stop integrated collection; they do not
									prove physical deletion.
								</Body>
							</View>
						</Disclosure>
					</If>
				</Block>
				<If when={s()}>
					<If
						when={clearing()}
						else={
							<Block>
								<Buttons>
									<Button
										kind="destructive"
										label="Clear local diagnostics…"
										testID="privacy-clear"
										disabled={disabled()}
										onPress={() => clearing.set(true)}
									/>
								</Buttons>
								<Caption>OS logs, agent replies, exports, backups and uploaded data stay.</Caption>
							</Block>
						}
					>
						<Question
							title="Clear managed local evidence?"
							foot={
								<>
									<Button
										kind="destructive"
										label="Clear local evidence"
										testID="privacy-clear-confirm"
										disabled={disabled()}
										onPress={() => {
											clearing.set(false);
											void c.write("clear", null);
										}}
									/>
									<Button label="Cancel" onPress={() => clearing.set(false)} />
								</>
							}
						>
							<Body tone="muted" measure>
								Deletes managed service evidence, local feature counts and this app writer's log segments.
								Collection can write new records while enabled. OS logs, agent replies, exports, backups, other
								app writers and uploaded data remain. Writer results are reported separately.
							</Body>
						</Question>
					</If>
				</If>
			</Section>
			<Section
				title="Investigate a problem"
				more={
					(s()?.chats.items.length ?? 0) > 5
						? { label: all() ? "Show fewer" : "Show saved diagnoses", onPress: () => all.set(!all()) }
						: undefined
				}
				footnote={s()?.chats.hasMore ? "Only the first 100 active app-wide diagnoses are listed." : undefined}
			>
				<Block gap={3}>
					<Body tone="muted" measure>
						Ask a read-only specialist. No continuous AI monitor. Fixing code is a separate action.
					</Body>
					<Buttons>
						<Button
							label="Ask about Pilot"
							testID="diagnosis-ask"
							disabled={disabled()}
							onPress={() => asking.set(!asking())}
						/>
					</Buttons>
				</Block>
				<If when={asking()}>
					<Block>
						<Body tone="muted" measure>
							Focus: no chat, app-wide on this service. The specialist can read protected Pilot logs, chat
							history and operational evidence across this service. It cannot change work, enable collection or
							start a fix.
						</Body>
						<Body tone="muted" measure>
							Your question and the evidence it reads go to the selected model provider. This is separate from
							telemetry consent.
						</Body>
					</Block>
					<Rows>
						<Row
							title="Diagnosis model"
							trailing={
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
							}
						/>
						<Row
							title="Diagnosis thinking"
							trailing={
								<Picker
									label="Diagnosis thinking"
									testID="diagnosis-thinking"
									items={(model()?.thinkingLevels ?? []).map((level) => ({ value: level, title: level }))}
									value={diagnosisThinking() || null}
									placeholder="Choose supported thinking"
									disabled={disabled()}
									onChange={diagnosisThinking.set}
								/>
							}
						/>
					</Rows>
					<Block gap={3}>
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
						<Buttons>
							<Button
								label="Start diagnosis"
								testID="diagnosis-start"
								disabled={
									disabled() ||
									!model() ||
									!(model()?.thinkingLevels ?? []).includes(diagnosisThinking()) ||
									!diagnosisQuestion().trim() ||
									utf8Bytes(diagnosisQuestion()) > 8192
								}
								onPress={() => void begin()}
							/>
						</Buttons>
					</Block>
				</If>
				<Rows>
					<Each of={(s()?.chats.items ?? []).slice(0, all() ? 100 : 5)} key={(c) => c.sessionId}>
						{(chat) => (
							<Row
								title={chat().title || "Pilot diagnostics"}
								state={chat().status}
								trailing={
									<OpenChatAction
										label="Open diagnosis chat"
										accessibilityLabel="Open diagnosis chat"
										onPress={() => openChat(chat().sessionId, "Settings")}
									/>
								}
							/>
						)}
					</Each>
				</Rows>
			</Section>
		</View>
	);
}
export function DiagnosisReply(props: { controls: DiagnosisControls; sessionId: string }) {
	const c = props.controls;
	void c.read();
	const reads = keepRead(
		() => c.read(),
		() => c.readFailed?.() ?? false,
		() => !!c.snapshot(),
	);
	const text = () => diagnosisReplies()[props.sessionId] ?? "";
	const replyField = keepField(`diagnosis-reply-${props.sessionId}`, () => "chat", text);
	const send = async () => {
		const message = text();
		const r = await c.write("send", { sessionId: props.sessionId, message });
		if (r.accepted && text() === message) diagnosisReplies.set({ ...diagnosisReplies(), [props.sessionId]: "" });
	};
	return (
		<View class="gap-3">
			<Body tone="muted">Ask a follow-up. This specialist is read-only; a fix needs a separate start.</Body>
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
			<Buttons>
				<Button
					kind="primary"
					label="Send follow-up"
					testID="diagnosis-send"
					disabled={
						c.busy() ||
						!c.snapshot() ||
						c.operations().some((o) => o.pending) ||
						!text().trim() ||
						utf8Bytes(text()) > 8192
					}
					onPress={() => void send()}
				/>
				<If when={reads.warn()}>
					<Button label="Try now" disabled={c.busy()} onPress={() => void reads.now()} />
				</If>
			</Buttons>
			<DiagnosisStatus controls={c} />
		</View>
	);
}
