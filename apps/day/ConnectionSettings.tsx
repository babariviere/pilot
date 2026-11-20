// Shared tool connections (MCP servers) in Settings' Tool connections tab: each connection is a row with its last
// checked state. Opening only reads; Check connection is the one command that probes.
import { effect, untracked, View } from "nsh";
import type { ConnectionControls, ConnectionServer } from "./connectionControls";
import {
	connectionAdding as adding,
	connectionBinding as binding,
	connectionKind as kind,
	connectionName as name,
	safeConnectionTarget,
	connectionTarget as target,
} from "./connectionDraft";
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
	Row,
	RowDetail,
	Rows,
	type RowTone,
	Section,
} from "./ui";

export function connectionState(s?: ConnectionServer): string {
	if (!s) return "Not checked";
	if (s.signIn?.state === "waiting") return "Waiting for browser sign-in";
	return (
		{
			connected: `Connected · ${s.tools ?? 0} tools`,
			needs_sign_in: "Needs sign-in",
			failed: "Connection failed",
			unknown: "Cannot check here",
			disabled: "Disabled",
		}[s.state] ?? "Not checked"
	);
}

/** The tone of a connection's state word: amber when the user can act, red when it failed. */
function stateTone(s?: ConnectionServer): RowTone {
	if (!s || s.signIn?.state === "waiting") return "quiet";
	if (s.state === "needs_sign_in") return "needs";
	if (s.state === "failed") return "failed";
	return "quiet";
}

/** Shared tool connections, separate from project preferences and provider sign-in. */
export function ConnectionSettings(props: { controls: ConnectionControls }) {
	const c = props.controls;
	effect(() => {
		untracked(() => void c.read());
	});
	const s = () => c.snapshot();
	const disabled = () => c.busy() || c.unknown().length > 0;
	return (
		<Section
			testID="connection-settings"
			title="Tool connections"
			action={
				<Link label="Read again" testID="connections-read" disabled={c.busy()} onPress={() => void c.read()} />
			}
		>
			<Block>
				<Body tone="muted" measure>
					Shared across projects. Pilot checks at startup and when configuration changes. Opening Settings shows
					the last check.
				</Body>
				<Buttons>
					<Button
						label={s()?.status?.checking ? "Checking…" : "Check connection"}
						testID="connections-probe"
						disabled={c.busy() || !s()?.status || s()?.status?.checking}
						onPress={() => void c.probe()}
					/>
				</Buttons>
				<If when={c.message()}>
					<Caption testID="connections-message">{c.message()}</Caption>
				</If>
			</Block>
			<Each of={c.unknown()} key={(o) => o.operationId}>
				{(o) => (
					<Notice
						kind="unconfirmed"
						placement="section"
						text="An action is Unknown. It will not be sent again."
						action={
							<Link
								label="Check status"
								testID="connections-receipt"
								disabled={c.busy()}
								onPress={() => void c.check(o().operationId)}
							/>
						}
					/>
				)}
			</Each>
			<If when={!s()}>
				<Notice
					kind="needs"
					placement="section"
					text="Connections could not be read. Read again to see setup and status."
				/>
			</If>
			<If when={s()}>
				<If when={!s()?.status}>
					<Notice
						kind="needs"
						placement="section"
						text="Connection checks are unavailable. Setup below is not a connection test."
					/>
				</If>
				<If when={s()?.setup.entries.length === 0}>
					<EmptyLine text="No tool connections configured." />
				</If>
				<Rows>
					<Each of={s()?.setup.entries ?? []} key={(e) => e.name}>
						{(e) => {
							const status = () => s()?.status?.servers.find((r) => r.name === e().name);
							return (
								<Row
									testID={`connection-${e().name}`}
									title={e().name}
									meta={e().blocked ? undefined : (e().config?.url ?? e().config?.command ?? undefined)}
									state={connectionState(status())}
									stateTone={stateTone(status())}
									trailing={
										<If when={status()?.canSignIn}>
											<If
												when={status()?.signIn?.state === "waiting"}
												else={
													<Button
														small
														label="Sign in"
														accessibilityLabel={`Sign in to ${e().name} in your browser`}
														disabled={disabled()}
														onPress={() => void c.write("sign-in", { server: e().name })}
													/>
												}
											>
												<Button
													small
													label="Cancel sign-in"
													disabled={c.busy()}
													onPress={() => {
														const run = status()?.signIn;
														if (run)
															void c.write("cancel", {
																server: e().name,
																expectedStartedAt: run.startedAt,
															});
													}}
												/>
											</If>
										</If>
									}
									detail={
										<If
											when={
												e().blocked ||
												e().dependencyAvailable === false ||
												status()?.problem ||
												status()?.checkedAt ||
												status()?.signIn?.state === "failed"
											}
										>
											<RowDetail>
												<If when={e().blocked}>
													<Caption tone="faint">
														Unsupported setup in Pilot. Advanced settings stay unchanged; edit this entry
														in Pi's mcp.json.
													</Caption>
												</If>
												<If when={e().dependencyAvailable === false}>
													<Caption tone="needs">
														Command not found on this host. Pilot does not install it.
													</Caption>
												</If>
												<If when={status()?.problem}>
													<Caption>{status()?.problem ?? ""}</Caption>
												</If>
												<If when={status()?.checkedAt}>
													<Caption tone="faint">{`Last checked: ${new Date(status()?.checkedAt ?? 0).toLocaleString()}`}</Caption>
												</If>
												<If when={status()?.signIn?.state === "failed"}>
													<Caption tone="needs">
														Sign-in failed. Check connection before trying again.
													</Caption>
												</If>
											</RowDetail>
										</If>
									}
								/>
							);
						}}
					</Each>
				</Rows>
				<If when={(s()?.setup.invalidNames ?? 0) > 0 || (s()?.status?.configProblems ?? 0) > 0}>
					<Notice
						kind="needs"
						placement="section"
						text={`${s()?.setup.invalidNames ?? 0} unsupported names; ${s()?.status?.configProblems ?? 0} rejected entries. Check Pi's mcp.json. Nothing is removed.`}
					/>
				</If>
				<If when={!s()?.readOnly}>
					<If
						when={!adding()}
						else={
							<View testID="connection-add-form">
								<Block>
									<Body tone="muted" measure>
										Add a connection without changing existing entries. For credentials, headers or command
										arguments, use Pi's mcp.json instead.
									</Body>
								</Block>
								<If when={binding() !== s()?.binding}>
									<Notice
										kind="needs"
										placement="section"
										text="Connections changed while you edited. Review the list above before keeping this draft."
										action={
											<Link
												label="Keep my draft"
												disabled={disabled()}
												onPress={() => binding.set(s()?.binding ?? "")}
											/>
										}
									/>
								</If>
								<Block>
									<Field label="Connection name" testID="connection-name" value={name()} onChange={name.set} />
								</Block>
								<Rows>
									<Row
										title="Connection type"
										trailing={
											<Picker
												label="Connection type"
												placeholder="Choose a connection type"
												value={kind()}
												items={[
													{ value: "url", title: "HTTPS service" },
													{ value: "command", title: "Installed command" },
												]}
												onChange={(v) => {
													kind.set(v);
													target.set("");
												}}
											/>
										}
									/>
								</Rows>
								<Block gap={3}>
									<Field
										label={kind() === "url" ? "Service URL" : "Command name"}
										testID="connection-target"
										value={target()}
										help="HTTPS URLs use a public hostname and a standard MCP path, without credentials or query parameters. Commands must already be on this host's PATH."
										error={
											target() && !safeConnectionTarget(kind(), target().trim())
												? "Use an HTTPS URL without credentials, or a command name without arguments. These fields do not save credentials."
												: undefined
										}
										onChange={target.set}
									/>
									<Buttons>
										<Button
											kind="primary"
											label="Add connection"
											testID="connection-save"
											disabled={
												disabled() || !name().trim() || !safeConnectionTarget(kind(), target().trim())
											}
											onPress={() =>
												void c
													.write(
														"add",
														{ name: name().trim(), config: { [kind()]: target().trim() } },
														binding(),
													)
													.then((ok) => {
														if (ok) {
															adding.set(false);
															name.set("");
															target.set("");
														}
													})
											}
										/>
										<Button label="Cancel" disabled={c.busy()} onPress={() => adding.set(false)} />
									</Buttons>
								</Block>
							</View>
						}
					>
						<Block>
							<Buttons>
								<Button
									label="Add connection…"
									testID="connection-add"
									disabled={disabled()}
									onPress={() => {
										binding.set(s()?.binding ?? "");
										adding.set(true);
									}}
								/>
							</Buttons>
						</Block>
					</If>
				</If>
			</If>
		</Section>
	);
}
