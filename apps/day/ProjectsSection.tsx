import { effect, signal, Text, untracked, View } from "nsh";
import {
	type ImportPreview,
	nativeProjects,
	type ProjectSetup,
	type ProjectsReply,
	type ProjectsSource,
	projectDestination,
	projectFolder,
	projectRepository,
	type SourcePreview,
} from "./projectSetup";
import { Action, CheckboxRow, Disclosure, QuietPanel, SectionTitle, TextField } from "./ui";

// Keep Settings small; paging reaches every project and saved import.
const PAGE_SIZE = 5;

/** Project setup belongs to the profile, not whichever project Settings currently shows. */
export function ProjectsSection(props: { source?: ProjectsSource }) {
	const source = props.source ?? nativeProjects;
	const snapshot = signal<ProjectSetup | null>(null);
	const operations = signal<NonNullable<ProjectsReply["operations"]>>([]);
	const busy = signal(false),
		message = signal("");
	const form = signal<"" | "folder" | "repository">("");
	const preview = signal<SourcePreview | null>(null),
		imported = signal<ImportPreview | null>(null);
	const projectPage = signal(0),
		importPage = signal(0),
		github = signal(false);
	const linksOpen = signal("");
	const unsettled = () => operations().filter((o) => o.state === "unknown" || o.state === "pending");
	const accept = (r: ProjectsReply) => {
		if (r.snapshot) {
			snapshot.set(r.snapshot);
			projectPage.set(Math.min(projectPage(), Math.max(0, Math.ceil(r.snapshot.projects.length / PAGE_SIZE) - 1)));
			importPage.set(Math.min(importPage(), Math.max(0, Math.ceil(r.snapshot.imports.length / PAGE_SIZE) - 1)));
		}
		if (r.operations) operations.set(r.operations);
		if (r.outcome)
			message.set(
				r.outcome.state === "accepted"
					? "Saved. Check the status below."
					: (r.outcome.receipt?.reason ?? "Result unknown. Check only reads the saved action."),
			);
	};
	const run = async (f: () => Promise<void>) => {
		if (busy()) return;
		busy.set(true);
		message.set("");
		try {
			await f();
		} catch (e) {
			message.set(e instanceof Error ? e.message : "Project setup is unavailable.");
		} finally {
			busy.set(false);
		}
	};
	const read = () => run(async () => accept(await source.read()));
	const action = (args: Record<string, string>) => run(async () => accept(await source.action(args)));
	const disabled = () => busy() || unsettled().length > 0 || !snapshot();
	const linkedNames = (linked: string[] | undefined) =>
		(linked ?? []).flatMap((id) => snapshot()?.projects.find((p) => p.id === id)?.name ?? []);
	effect(() => {
		untracked(() => {
			void read();
		});
	});
	return (
		<View testID="project-setup" class="gap-4">
			<View class="flex-row items-center gap-3">
				<View class="flex-1">
					<SectionTitle title="Local projects" />
				</View>
				<Action
					label={busy() ? "Reading…" : "Read again"}
					testID="projects-refresh"
					disabled={busy()}
					onPress={() => void read()}
				/>
			</View>
			<Text class="text-sm text-muted-foreground">
				With a Git remote, agents code in private jj copies and read main in a read-only copy. Without a remote,
				they use your folder.
			</Text>
			<Each
				of={snapshot()?.projects.slice(projectPage() * PAGE_SIZE, (projectPage() + 1) * PAGE_SIZE) ?? []}
				key={(p) => p.id}
			>
				{(p) => (
					<View class="gap-1 border-t border-border pt-3">
						<Text class="text-sm font-medium text-foreground">{p().name}</Text>
						<Text testID={`project-copy-${p().id}`} class="text-xs text-muted-foreground">
							{p().copy === "jj"
								? "Private jj coding copies · Read-only main"
								: p().copy === "folder"
									? "Your folder · Local edits change as you work"
									: "Existing project settings · Source policy unchanged"}
						</Text>
						<View selectable>
							<Text class="text-xs text-faint">{`Source folder: ${p().path}`}</Text>
						</View>
						<Each of={p().setup} key={(s) => s.id}>
							{(s) => (
								<Text class="text-xs text-faint">{`${s().enabled ? "Configured setup" : "Disabled setup"}: ${s().name}`}</Text>
							)}
						</Each>
						<If when={snapshot()?.profiles}>
							{(profiles) => (
								<View testID={`project-profiles-${p().id}`} class="gap-1">
									<Text class="text-xs text-muted-foreground">
										Profiles allowed in this project. The planner picks from these for each task.
									</Text>
									<View class="flex-row flex-wrap gap-x-2">
										<Each of={profiles()} key={(w) => w.id}>
											{(w) => (
												<CheckboxRow
													testID={`project-profile-${p().id}-${w().id}`}
													tickTestID={`project-profile-tick-${p().id}-${w().id}`}
													label={w().name}
													checked={(p().profiles ?? []).includes(w().id)}
													disabled={disabled()}
													onChange={() =>
														void action({
															action: (p().profiles ?? []).includes(w().id)
																? "stop-profile"
																: "allow-profile",
															project: p().id,
															profile: w().id,
														})
													}
												/>
											)}
										</Each>
									</View>
								</View>
							)}
						</If>
						<If when={(snapshot()?.projects.length ?? 0) > 1}>
							<Disclosure
								testID={`project-links-${p().id}`}
								label={`Also reads: ${linkedNames(p().linked).join(", ") || "none"}`}
								open={linksOpen() === p().id}
								onToggle={() => linksOpen.set(linksOpen() === p().id ? "" : p().id)}
							>
								<View class="gap-1 pl-4">
									<Text class="text-xs text-muted-foreground">
										Agents in this project can read the main branch of the projects you tick. Read-only.
									</Text>
									<Each of={snapshot()?.projects.filter((o) => o.id !== p().id) ?? []} key={(o) => o.id}>
										{(o) => (
											<CheckboxRow
												testID={`project-link-${p().id}-${o().id}`}
												label={o().name}
												checked={(p().linked ?? []).includes(o().id)}
												disabled={disabled()}
												onChange={() =>
													void action({
														action: (p().linked ?? []).includes(o().id) ? "unlink" : "link",
														project: p().id,
														linked: o().id,
													})
												}
											/>
										)}
									</Each>
								</View>
							</Disclosure>
						</If>
					</View>
				)}
			</Each>
			<If when={(snapshot()?.projects.length ?? 0) > 5}>
				<View class="flex-row gap-2">
					<Action
						label="Previous projects"
						disabled={projectPage() === 0}
						onPress={() => projectPage.set(projectPage() - 1)}
					/>
					<Action
						label="Next projects"
						disabled={(projectPage() + 1) * PAGE_SIZE >= (snapshot()?.projects.length ?? 0)}
						onPress={() => projectPage.set(projectPage() + 1)}
					/>
				</View>
			</If>
			<If when={snapshot()?.projects.length === 0}>
				<Text class="text-sm text-muted-foreground">Add a folder to start.</Text>
			</If>
			<View class="flex-row gap-2">
				<Action
					label="Add local folder"
					testID="projects-local"
					disabled={disabled()}
					onPress={() => form.set(form() === "folder" ? "" : "folder")}
				/>
				<Action
					label="Import repository"
					testID="projects-import"
					disabled={disabled()}
					onPress={() => form.set(form() === "repository" ? "" : "repository")}
				/>
			</View>
			<If when={form() === "folder"}>
				<View class="gap-3">
					<Text class="text-sm text-foreground">Local folder</Text>
					<TextField
						testID="project-folder"
						accessibilityLabel="Local folder"
						value={projectFolder()}
						onChange={(e) => {
							projectFolder.set(e.value);
							preview.set(null);
						}}
						placeholder="/Users/you/src/project"
					/>
					<Action
						label="Preview folder"
						testID="project-preview"
						disabled={disabled() || !projectFolder().trim()}
						onPress={() =>
							void run(async () => {
								const path = projectFolder();
								const p = await source.preview({ path });
								if (projectFolder() === path && "copy" in p) preview.set(p);
							})
						}
					/>
					<If when={preview()}>
						<QuietPanel class="gap-2">
							<Text class="text-sm text-foreground">
								{preview()?.copy === "jj"
									? "Agents will use private jj copies. Main is read-only."
									: "Agents will edit your folder directly. Local edits stay visible."}
							</Text>
							<View selectable>
								<Text class="text-xs text-muted-foreground">{preview()?.path ?? ""}</Text>
							</View>
							<Action
								label="Add project"
								testID="project-add"
								variant="primary"
								disabled={disabled()}
								onPress={() => {
									const p = preview();
									if (p) void action({ action: "add", path: p.path, digest: p.digest });
								}}
							/>
						</QuietPanel>
					</If>
				</View>
			</If>
			<If when={form() === "repository"}>
				<View class="gap-3">
					<Text class="text-sm text-foreground">GitHub repository</Text>
					<TextField
						testID="project-url"
						accessibilityLabel="Repository URL"
						value={projectRepository()}
						onChange={(e) => {
							projectRepository.set(e.value);
							imported.set(null);
						}}
						placeholder="https://github.com/owner/repository"
					/>
					<TextField
						testID="project-destination"
						accessibilityLabel="Import destination"
						value={projectDestination()}
						onChange={(e) => {
							projectDestination.set(e.value);
							imported.set(null);
						}}
						placeholder="Destination (optional)"
					/>
					<Action
						label="Preview import"
						testID="import-preview"
						disabled={disabled() || !projectRepository().trim()}
						onPress={() =>
							void run(async () => {
								const url = projectRepository(),
									destination = projectDestination();
								const p = await source.preview({ url, ...(destination ? { destination } : {}) });
								if (
									projectRepository() === url &&
									projectDestination() === destination &&
									"resolvedDestination" in p
								)
									imported.set(p);
							})
						}
					/>
					<If when={imported()}>
						<QuietPanel class="gap-2">
							<View selectable>
								<Text class="text-sm text-foreground">{imported()?.resolvedDestination ?? ""}</Text>
							</View>
							<Text class="text-xs text-muted-foreground">
								One local checkout, then private jj coding copies. Interrupted imports keep their files.
								Existing folders need confirmation.
							</Text>
							<Action
								label="Import repository"
								testID="import-start"
								variant="primary"
								disabled={disabled() || !snapshot()?.github.apiReady || !snapshot()?.github.sshReady}
								onPress={() => {
									const p = imported();
									if (p)
										void action({
											action: "import",
											url: projectRepository(),
											destination: p.resolvedDestination,
										});
								}}
							/>
						</QuietPanel>
					</If>
				</View>
			</If>
			<Each
				of={
					snapshot()
						?.imports.slice()
						.reverse()
						.slice(importPage() * PAGE_SIZE, (importPage() + 1) * PAGE_SIZE) ?? []
				}
				key={(i) => i.id}
			>
				{(i) => (
					<View class="gap-2 border-t border-border pt-3">
						<Text class="text-sm text-foreground">{`${i().url} · ${i().phase}`}</Text>
						<View selectable>
							<Text class="text-xs text-muted-foreground">{i().destination}</Text>
						</View>
						<If when={i().problem}>
							<Text class="text-xs text-muted-foreground">{i().problem ?? ""}</Text>
						</If>
						<If when={["interrupted", "failed", "cancelled"].includes(i().phase)}>
							<Action
								label="Resume import"
								disabled={disabled()}
								onPress={() => void action({ action: "resume", importId: i().id })}
							/>
						</If>
						<If when={i().phase === "confirm_existing"}>
							<Action
								label="Use this existing checkout"
								disabled={disabled()}
								onPress={() => void action({ action: "confirm_existing", importId: i().id })}
							/>
						</If>
						<If when={["queued", "cloning", "registering"].includes(i().phase)}>
							<Action
								label="Cancel import"
								disabled={busy() || !snapshot()}
								onPress={() => void action({ action: "cancel_import", importId: i().id })}
							/>
						</If>
					</View>
				)}
			</Each>
			<If when={(snapshot()?.imports.length ?? 0) > PAGE_SIZE}>
				<View class="flex-row gap-2">
					<Action
						label="Newer imports"
						disabled={importPage() === 0}
						onPress={() => importPage.set(importPage() - 1)}
					/>
					<Action
						label="Earlier imports"
						disabled={(importPage() + 1) * PAGE_SIZE >= (snapshot()?.imports.length ?? 0)}
						onPress={() => importPage.set(importPage() + 1)}
					/>
				</View>
			</If>
			<Action
				label={github() ? "Hide GitHub setup" : "GitHub access and SSH setup"}
				testID="github-setup-open"
				onPress={() => github.set(!github())}
			/>
			<If when={github()}>
				<View class="gap-3 border-t border-border pt-3">
					<Text class="text-sm text-foreground">
						{snapshot()?.github.account
							? `GitHub account: ${snapshot()?.github.account}`
							: "GitHub access has not been checked."}
					</Text>
					<Text class="text-xs text-muted-foreground">
						{snapshot()?.github.sshReady
							? `SSH verified (${snapshot()?.github.sshIdentity ?? "dedicated"}).`
							: "SSH is not verified. Existing credentials and configuration are kept."}
					</Text>
					<If when={snapshot()?.github.problem}>
						<Text class="text-sm text-muted-foreground">{snapshot()?.github.problem ?? ""}</Text>
					</If>
					<View class="flex-row gap-2">
						<Action
							label="Check existing access"
							testID="github-verify"
							disabled={disabled()}
							onPress={() => void action({ action: "verify_existing" })}
						/>
						<Action
							label="Sign in to GitHub"
							disabled={disabled() || snapshot()?.github.apiReady}
							onPress={() => void action({ action: "authorize" })}
						/>
					</View>
					<If when={snapshot()?.github.challenge}>
						<View selectable>
							<Text class="text-sm text-foreground">{`Open ${snapshot()?.github.challenge?.url} in your browser. Enter code ${snapshot()?.github.challenge?.code}.`}</Text>
						</View>
						<Action
							label="Cancel sign-in"
							disabled={busy() || !snapshot()}
							onPress={() => void action({ action: "cancel" })}
						/>
					</If>
					<Action
						label="Prepare optional dedicated SSH key"
						disabled={disabled() || !snapshot()?.github.apiReady}
						onPress={() => void action({ action: "prepare_key" })}
					/>
					<If when={snapshot()?.github.fingerprint}>
						<View selectable>
							<Text class="text-xs text-muted-foreground">{`Dedicated key fingerprint: ${snapshot()?.github.fingerprint}`}</Text>
						</View>
						<Action
							label="Approve this key for this account"
							disabled={disabled()}
							onPress={() =>
								void action({
									action: "approve_key",
									account: snapshot()?.github.account ?? "",
									fingerprint: snapshot()?.github.fingerprint ?? "",
								})
							}
						/>
						<Action
							label="Check dedicated key"
							disabled={disabled()}
							onPress={() => void action({ action: "verify" })}
						/>
					</If>
				</View>
			</If>
			<Each of={unsettled()} key={(o) => o.operationId}>
				{(o) => (
					<QuietPanel class="gap-2">
						<Text class="text-sm text-foreground">
							The previous action is unconfirmed. Check only reads its receipt.
						</Text>
						<Action
							label="Check action"
							testID="project-check"
							disabled={busy()}
							onPress={() => void run(async () => accept(await source.check(o().operationId)))}
						/>
					</QuietPanel>
				)}
			</Each>
			<If when={message()}>
				<Text testID="projects-message" class="text-sm text-muted-foreground">
					{message()}
				</Text>
			</If>
		</View>
	);
}
