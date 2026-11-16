import { effect, Text, untracked, View } from "nsh";
import type { ConnectionControls, ConnectionServer } from "./connectionControls";
import {
	connectionAdding as adding,
	connectionBinding as binding,
	connectionKind as kind,
	connectionName as name,
	safeConnectionTarget,
	connectionTarget as target,
} from "./connectionDraft";
import { Action, Field, Picker, SectionTitle } from "./ui";

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

/** Shared tool connections, separate from project preferences and provider sign-in. */
export function ConnectionSettings(props: { controls: ConnectionControls }) {
	const c = props.controls;
	effect(() => {
		untracked(() => void c.read());
	});
	const s = () => c.snapshot();
	const disabled = () => c.busy() || c.unknown().length > 0;
	return (
		<View testID="connection-settings" class="gap-4">
			<View class="gap-1.5">
				<SectionTitle title="Tool connections" />
				<Text class="text-sm text-muted-foreground">
					Shared across projects. Pilot checks at startup and when configuration changes. Opening Settings shows
					the last check.
				</Text>
			</View>
			<View class="flex-row gap-2">
				<Action
					label={s()?.status?.checking ? "Checking…" : "Check connection"}
					testID="connections-probe"
					disabled={c.busy() || !s()?.status || s()?.status?.checking}
					onPress={() => void c.probe()}
				/>
				<Action label="Read again" testID="connections-read" disabled={c.busy()} onPress={() => void c.read()} />
			</View>
			<If when={c.message()}>
				<Text testID="connections-message" class="text-sm text-needs-ink">
					{c.message()}
				</Text>
			</If>
			<Each of={c.unknown()} key={(o) => o.operationId}>
				{(o) => (
					<View class="gap-2 border-t border-border pt-3">
						<Text class="text-sm text-needs-ink">An action is Unknown. It will not be sent again.</Text>
						<Action
							label="Check status"
							testID="connections-receipt"
							disabled={c.busy()}
							onPress={() => void c.check(o().operationId)}
						/>
					</View>
				)}
			</Each>
			<If when={!s()}>
				<Text class="text-sm text-muted-foreground">
					Connections could not be read. Read again to see setup and status.
				</Text>
			</If>
			<If when={s()}>
				<If when={!s()?.status}>
					<Text class="text-sm text-needs-ink">
						Connection checks are unavailable. Setup below is not a connection test.
					</Text>
				</If>
				<If when={s()?.setup.entries.length === 0}>
					<Text class="text-sm text-muted-foreground">No tool connections configured.</Text>
				</If>
				<Each of={s()?.setup.entries ?? []} key={(e) => e.name}>
					{(e) => {
						const status = () => s()?.status?.servers.find((r) => r.name === e().name);
						return (
							<View testID={`connection-${e().name}`} class="gap-2 border-t border-border py-3">
								<View class="flex-row items-baseline gap-3">
									<Text class="flex-1 text-sm font-medium text-foreground">{e().name}</Text>
									<Text class="text-xs text-muted-foreground">{connectionState(status())}</Text>
								</View>
								<If when={e().blocked}>
									<Text class="text-xs text-faint">
										Unsupported setup in Pilot. Advanced settings stay unchanged; edit this entry in Pi's
										mcp.json.
									</Text>
								</If>
								<If when={!e().blocked}>
									<Text class="text-xs text-faint">{e().config?.url ?? e().config?.command ?? ""}</Text>
								</If>
								<If when={e().dependencyAvailable === false}>
									<Text class="text-xs text-needs-ink">
										Command not found on this host. Pilot does not install it.
									</Text>
								</If>
								<If when={status()?.problem}>
									<Text class="text-xs text-muted-foreground">{status()?.problem ?? ""}</Text>
								</If>
								<If when={status()?.checkedAt}>
									<Text class="text-xs text-faint">{`Last checked: ${new Date(status()?.checkedAt ?? 0).toLocaleString()}`}</Text>
								</If>
								<If when={status()?.signIn?.state === "failed"}>
									<Text class="text-xs text-needs-ink">
										Sign-in failed. Check connection before trying again.
									</Text>
								</If>
								<If when={status()?.canSignIn}>
									<View class="flex-row gap-2">
										<If
											when={status()?.signIn?.state === "waiting"}
											else={
												<Action
													label="Sign in"
													accessibilityLabel={`Sign in to ${e().name} in your browser`}
													disabled={disabled()}
													onPress={() => void c.write("sign-in", { server: e().name })}
												/>
											}
										>
											<Action
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
									</View>
								</If>
							</View>
						);
					}}
				</Each>
				<If when={(s()?.setup.invalidNames ?? 0) > 0 || (s()?.status?.configProblems ?? 0) > 0}>
					<Text class="text-sm text-needs-ink">{`${s()?.setup.invalidNames ?? 0} unsupported names; ${s()?.status?.configProblems ?? 0} rejected entries. Check Pi's mcp.json. Nothing is removed.`}</Text>
				</If>
				<If when={!s()?.readOnly}>
					<If
						when={!adding()}
						else={
							<View testID="connection-add-form" class="gap-3 border-t border-border pt-3">
								<Text class="text-sm text-muted-foreground">
									Add a connection without changing existing entries. For credentials, headers or command
									arguments, use Pi's mcp.json instead.
								</Text>
								<If when={binding() !== s()?.binding}>
									<Text class="text-sm text-needs-ink">
										Connections changed while you edited. Review the list above before keeping this draft.
									</Text>
									<Action
										label="Keep my draft"
										disabled={disabled()}
										onPress={() => binding.set(s()?.binding ?? "")}
									/>
								</If>
								<Field label="Connection name" testID="connection-name" value={name()} onChange={name.set} />
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
								<Field
									label={kind() === "url" ? "Service URL" : "Command name"}
									testID="connection-target"
									value={target()}
									onChange={target.set}
								/>
								<Text class="text-xs text-faint">
									HTTPS URLs use a public hostname and a standard MCP path, without credentials or query
									parameters. Commands must already be on this host's PATH.
								</Text>
								<If when={target() && !safeConnectionTarget(kind(), target().trim())}>
									<Text class="text-xs text-needs-ink">
										Use an HTTPS URL without credentials, or a command name without arguments. These fields do
										not save credentials.
									</Text>
								</If>
								<View class="flex-row gap-2">
									<Action
										variant="primary"
										label="Add connection"
										testID="connection-save"
										disabled={disabled() || !name().trim() || !safeConnectionTarget(kind(), target().trim())}
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
									<Action label="Cancel" disabled={c.busy()} onPress={() => adding.set(false)} />
								</View>
							</View>
						}
					>
						<View class="flex-row">
							<Action
								label="Add connection…"
								testID="connection-add"
								disabled={disabled()}
								onPress={() => {
									binding.set(s()?.binding ?? "");
									adding.set(true);
								}}
							/>
						</View>
					</If>
				</If>
			</If>
		</View>
	);
}
