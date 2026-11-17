import { effect, Keyboard, Text, untracked, View } from "nsh";
import type { DatabaseControls } from "./databaseControls";
import { databaseDraft as draft } from "./databaseDraft";
import { Action, Field, Picker, SectionTitle } from "./ui";

/** Same disclosure in Today and Settings. Never turns a regular answer into access. */
export function DatabaseApprovals(props: { controls: DatabaseControls }) {
	const c = props.controls;
	const disabled = () => !c.current() || c.busy() || c.unknown().length > 0;
	return (
		<View class="gap-4">
			<If when={!!c.snapshot() && !c.current()}>
				<Text class="text-sm text-muted-foreground">
					Database access is from an earlier read. Read again before deciding.
				</Text>
				<Action label="Read database access again" disabled={c.busy()} onPress={() => void c.refresh()} />
			</If>
			<Each of={c.snapshot()?.agents.filter((a) => !!a.request) ?? []} key={(a) => a.id}>
				{(a) => {
					const r = () => a().request!;
					const target = () => c.snapshot()?.settings.environments.find((e) => e.name === r().env)?.[r().mode];
					return (
						<View testID="database-approval" class="gap-3 border-t border-border pt-4">
							<Text class="text-lg font-medium text-foreground">Allow database access?</Text>
							<Text class="text-sm text-foreground">{a().title}</Text>
							<If when={!a().eligible}>
								<Text class="text-sm text-muted-foreground">
									This agent is not eligible now. Its saved access can still be revoked.
								</Text>
							</If>
							<Text class="text-sm text-foreground">{`${r().env} · ${r().mode === "write" ? "Read and write" : "Read-only"}`}</Text>
							<Text class="text-sm text-foreground">{`Destination: ${r().destination ?? "Unavailable. Request fresh approval."}`}</Text>
							<Text class="text-sm text-foreground">{`Model provider: ${r().provider ?? "Unavailable"}`}</Text>
							<Text class="text-sm text-muted-foreground">
								Query results enter this agent’s context and may be sent to its model provider. Writes can
								change database data.
							</Text>
							<Text class="text-sm text-muted-foreground">
								Approval lasts until revoked or archived. A different destination or provider needs fresh
								approval.
							</Text>
							<Text class={target()?.tlsException ? "text-sm text-needs-ink" : "text-sm text-muted-foreground"}>
								{target()?.tlsException
									? `TLS exception: ${target()!.tlsException!.name} (${target()!.tlsException!.mode}). This connection is not verified TLS.`
									: (target()?.tlsWarning ?? "Verified TLS required")}
							</Text>
							<View class="flex-row gap-2">
								<Action
									label={a().eligible ? "Deny" : "Revoke request and access"}
									disabled={a().eligible ? disabled() : !c.current() || c.busy()}
									onPress={() =>
										void (a().eligible
											? c.write("decide", { agentId: a().id, requestId: r().id, allow: false })
											: c.write("revoke", { agentId: a().id, env: r().env, mode: r().mode }))
									}
								/>
								<Action
									label={r().mode === "write" ? "Allow read and write" : "Allow read-only"}
									variant="primary"
									disabled={
										disabled() || !a().eligible || !r().scope || !r().provider || !!target()?.tlsWarning
									}
									onPress={() => void c.write("decide", { agentId: a().id, requestId: r().id, allow: true })}
								/>
							</View>
						</View>
					);
				}}
			</Each>
		</View>
	);
}

export function DatabaseSettings(props: { controls: DatabaseControls }) {
	const c = props.controls;
	effect(() => untracked(() => void c.refresh()));
	const s = () => c.snapshot();
	const disabled = () => !c.current() || c.busy() || c.unknown().length > 0;
	const set = (key: keyof ReturnType<typeof draft>, value: string) => draft.set({ ...draft(), [key]: value });
	const begin = (name = "", mode = "read") => {
		const e = s()?.settings.environments.find((e) => e.name === name);
		const target = mode === "read" ? e?.read : e?.write;
		draft.set({
			projectId: s()!.projectId,
			binding: s()!.binding,
			name,
			mode,
			host: target
				? `${target.host.includes(":") && !target.host.startsWith("[") ? `[${target.host}]` : target.host}${target.port ? `:${target.port}` : ""}`
				: "",
			user: target?.user ?? "",
			database: target?.database ?? "",
			transport: target?.tlsException?.mode ?? "verified",
			exception: target?.tlsException?.name ?? "",
		});
	};
	async function save() {
		const d = draft(),
			snapshot = s();
		if (!snapshot || snapshot.projectId !== d.projectId || snapshot.binding !== d.binding) return;
		const { binding, ...value } = d;
		if (await c.write("edit", value, binding)) {
			Keyboard.dismiss();
			set("binding", "");
		}
	}
	return (
		<View testID="database-settings" class="gap-4">
			<View class="gap-1.5">
				<SectionTitle title="Databases" />
				<Text class="text-sm text-muted-foreground">
					Project connections. Each work agent needs your approval before use.
				</Text>
			</View>
			<Action label="Read again" testID="database-read" disabled={c.busy()} onPress={() => void c.refresh()} />
			<If when={c.message()}>
				<Text testID="database-message" class="text-sm text-needs-ink">
					{c.message()}
				</Text>
			</If>
			<Each of={c.unknown()} key={(o) => o.operationId}>
				{(o) => (
					<View class="gap-2">
						<Text class="text-sm text-needs-ink">An action is Unknown. It will not be sent again.</Text>
						<Action label="Check status" disabled={c.busy()} onPress={() => void c.check(o().operationId)} />
					</View>
				)}
			</Each>
			<If when={!s()}>
				<Text class="text-sm text-muted-foreground">
					Choose a project in Today to read its database settings. Failed reads do not mean no connections exist.
				</Text>
			</If>
			<If when={s()}>
				<If when={!s()?.settings.environments.length}>
					<Text class="text-sm text-muted-foreground">No database connections configured for this project.</Text>
				</If>
				<Each of={s()?.settings.environments ?? []} key={(e) => e.name}>
					{(e) => (
						<View class="gap-3 border-t border-border pt-4">
							<Text class="text-lg font-medium text-foreground">{e().name}</Text>
							<Each of={(["read", "write"] as const).filter((m) => !!e()[m])} key={(m) => m}>
								{(m) => (
									<View class="gap-2">
										<Text class="text-sm text-foreground">{`${m()}: ${e()[m()]!.user}@${e()[m()]!.host}:${e()[m()]!.port || "5432"}/${e()[m()]!.database}`}</Text>
										<Text
											class={
												e()[m()]!.tlsException ? "text-sm text-needs-ink" : "text-sm text-muted-foreground"
											}
										>
											{e()[m()]!.tlsException
												? `TLS exception: ${e()[m()]!.tlsException!.name} (${e()[m()]!.tlsException!.mode}). Not verified TLS.`
												: (e()[m()]!.tlsWarning ?? "Verified TLS required")}
										</Text>
										<View class="flex-row gap-2">
											<Action
												label={`Test ${m()} connection`}
												disabled={disabled()}
												onPress={() => void c.write("test", { env: e().name, mode: m() })}
											/>
											<Action
												label={`Edit ${m()}…`}
												disabled={disabled() || !!draft().binding}
												onPress={() => begin(e().name, m())}
											/>
										</View>
									</View>
								)}
							</Each>
							<Action
								label="Add write connection…"
								disabled={disabled() || !!e().write || !!draft().binding}
								onPress={() => begin(e().name, "write")}
							/>
						</View>
					)}
				</Each>
				<Text class="text-xs text-muted-foreground">
					Saving does not connect. Tests authenticate without SQL or changes to database data. Advanced credentials
					and certificates stay in database.json; unchanged destinations keep them.
				</Text>
				<Action
					label="Add environment…"
					testID="database-add"
					disabled={disabled() || !!draft().binding}
					onPress={() => begin()}
				/>
			</If>
			<If when={draft().binding}>
				<View class="gap-3 border-t border-border pt-4">
					<Action
						label="Cancel editing"
						onPress={() => {
							Keyboard.dismiss();
							set("binding", "");
						}}
					/>
					<Text class="text-sm text-muted-foreground">
						{draft().binding === s()?.binding && draft().projectId === s()?.projectId
							? "Edit connection"
							: "Settings changed. Your draft stays, but cannot be saved. Read again and explicitly reopen Edit to start from current settings."}
					</Text>
					<Field
						label="Environment"
						value={draft().name}
						onChange={(v) => set("name", v)}
						testID="database-environment"
					/>
					<Picker
						label="Access mode"
						value={draft().mode}
						placeholder="Mode"
						items={[
							{ value: "read", title: "Read-only" },
							{ value: "write", title: "Read and write" },
						]}
						onChange={(v) => set("mode", v)}
					/>
					<Field
						label="Host and optional port"
						value={draft().host}
						onChange={(v) => set("host", v)}
						testID="database-host"
					/>
					<Field label="Database user" value={draft().user} onChange={(v) => set("user", v)} />
					<Field label="Database name" value={draft().database} onChange={(v) => set("database", v)} />
					<Picker
						label="Transport"
						value={draft().transport}
						placeholder="Transport"
						items={[
							{ value: "verified", title: "Verified TLS required" },
							{ value: "plaintext", title: "Local / legacy: no TLS" },
							{ value: "unverified", title: "Legacy: unverified TLS" },
						]}
						onChange={(v) => set("transport", v)}
					/>
					<If when={draft().transport !== "verified"}>
						<Field label="Exception name" value={draft().exception} onChange={(v) => set("exception", v)} />
						<Text class="text-sm text-needs-ink">
							This exception removes transport protections. Its name and warning stay visible when access is
							approved.
						</Text>
					</If>
					<Action
						label="Save"
						variant="primary"
						testID="database-save"
						disabled={
							disabled() ||
							draft().binding !== s()?.binding ||
							draft().projectId !== s()?.projectId ||
							!draft().host ||
							!draft().user ||
							!draft().database ||
							!draft().name
						}
						onPress={() => void save()}
					/>
				</View>
			</If>
			<DatabaseApprovals controls={c} />
			<Each of={s()?.agents ?? []} key={(a) => a.id}>
				{(a) => (
					<Each of={a().grants} key={(g) => `${g.env}/${g.mode}`}>
						{(g) => (
							<View class="gap-2 border-t border-border pt-3">
								<Text class="text-sm text-foreground">{`${a().title}: ${g().env} (${g().mode})`}</Text>
								<Text class="text-sm text-muted-foreground">{`${g().destination ?? "Legacy approval, no longer valid"} · ${g().provider ?? "Unknown provider"}`}</Text>
								<Action
									label="Revoke access"
									disabled={!c.current() || c.busy()}
									onPress={() => void c.write("revoke", { agentId: a().id, env: g().env, mode: g().mode })}
								/>
							</View>
						)}
					</Each>
				)}
			</Each>
			<Text class="text-xs text-muted-foreground">
				Queries keep existing bounds: 1,000 rows, 256 KiB of results, 30-second statements. Cut-off results are
				marked. Revocation blocks new queries; sent queries may finish. Uncertain writes require approved reads and
				safe evidence before retry.
			</Text>
		</View>
	);
}
