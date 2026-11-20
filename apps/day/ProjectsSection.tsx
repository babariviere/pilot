// Local projects in Settings' Local projects tab: each project is a row with its source policy, the work profiles
// it allows and the projects it also reads. Adding a folder or importing a repository needs a preview first.
import { effect, signal, untracked, View } from "nsh";
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
import {
	Block,
	Body,
	BodyStrong,
	Button,
	Buttons,
	Caption,
	Disclosure,
	EmptyLine,
	Link,
	Notice,
	Option,
	Quote,
	Row,
	RowDetail,
	Rows,
	Section,
	TextField,
} from "./ui";

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
		<Section
			testID="project-setup"
			title="Local projects"
			action={
				<Link
					label={busy() ? "Reading…" : "Read again"}
					testID="projects-refresh"
					disabled={busy()}
					onPress={() => void read()}
				/>
			}
		>
			<Block>
				<Body tone="muted" measure>
					With a Git remote, agents code in private jj copies and read main in a read-only copy. Without a remote,
					they use your folder.
				</Body>
			</Block>
			<Each of={unsettled()} key={(o) => o.operationId}>
				{(o) => (
					<Notice
						kind="needs"
						placement="section"
						text="The previous action is unconfirmed. Check only reads its receipt."
						action={
							<Link
								label="Check action"
								testID="project-check"
								disabled={busy()}
								onPress={() => void run(async () => accept(await source.check(o().operationId)))}
							/>
						}
					/>
				)}
			</Each>
			<If when={snapshot()?.projects.length === 0}>
				<EmptyLine text="Add a folder to start." />
			</If>
			<Rows>
				<Each
					of={snapshot()?.projects.slice(projectPage() * PAGE_SIZE, (projectPage() + 1) * PAGE_SIZE) ?? []}
					key={(p) => p.id}
				>
					{(p) => (
						<Row
							title={p().name}
							meta={`Source folder: ${p().path}`}
							selectable
							detail={
								<RowDetail>
									<Caption testID={`project-copy-${p().id}`}>
										{p().copy === "jj"
											? "Private jj coding copies · Read-only main"
											: p().copy === "folder"
												? "Your folder · Local edits change as you work"
												: "Existing project settings · Source policy unchanged"}
									</Caption>
									<Each of={p().setup} key={(s) => s.id}>
										{(s) => (
											<Caption tone="faint">{`${s().enabled ? "Configured setup" : "Disabled setup"}: ${s().name}`}</Caption>
										)}
									</Each>
									<If when={snapshot()?.profiles}>
										{(profiles) => (
											<View testID={`project-profiles-${p().id}`} class="gap-1">
												<Caption>
													Profiles allowed in this project. The planner picks from these for each task.
												</Caption>
												<View class="flex-row flex-wrap gap-x-2">
													<Each of={profiles()} key={(w) => w.id}>
														{(w) => (
															<ProfileBox
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
											<View class="gap-1">
												<Caption>
													Agents in this project can read the main branch of the projects you tick.
													Read-only.
												</Caption>
												<Each
													of={snapshot()?.projects.filter((o) => o.id !== p().id) ?? []}
													key={(o) => o.id}
												>
													{(o) => (
														<ProfileBox
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
								</RowDetail>
							}
						/>
					)}
				</Each>
			</Rows>
			<Block gap={3}>
				<If when={(snapshot()?.projects.length ?? 0) > 5}>
					<Buttons>
						<Button
							small
							label="Previous projects"
							disabled={projectPage() === 0}
							onPress={() => projectPage.set(projectPage() - 1)}
						/>
						<Button
							small
							label="Next projects"
							disabled={(projectPage() + 1) * PAGE_SIZE >= (snapshot()?.projects.length ?? 0)}
							onPress={() => projectPage.set(projectPage() + 1)}
						/>
					</Buttons>
				</If>
				<Buttons>
					<Button
						label="Add local folder"
						testID="projects-local"
						disabled={disabled()}
						onPress={() => form.set(form() === "folder" ? "" : "folder")}
					/>
					<Button
						label="Import repository"
						testID="projects-import"
						disabled={disabled()}
						onPress={() => form.set(form() === "repository" ? "" : "repository")}
					/>
				</Buttons>
				<If when={form() === "folder"}>
					<View class="gap-1.5">
						<BodyStrong>Local folder</BodyStrong>
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
					</View>
					<Buttons>
						<Button
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
					</Buttons>
					<If when={preview()}>
						<Body>
							{preview()?.copy === "jj"
								? "Agents will use private jj copies. Main is read-only."
								: "Agents will edit your folder directly. Local edits stay visible."}
						</Body>
						<Quote code text={preview()?.path ?? ""} />
						<Buttons>
							<Button
								kind="primary"
								label="Add project"
								testID="project-add"
								disabled={disabled()}
								onPress={() => {
									const p = preview();
									if (p) void action({ action: "add", path: p.path, digest: p.digest });
								}}
							/>
						</Buttons>
					</If>
				</If>
				<If when={form() === "repository"}>
					<View class="gap-1.5">
						<BodyStrong>GitHub repository</BodyStrong>
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
					</View>
					<Buttons>
						<Button
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
					</Buttons>
					<If when={imported()}>
						<Quote code text={imported()?.resolvedDestination ?? ""} />
						<Caption>
							One local checkout, then private jj coding copies. Interrupted imports keep their files. Existing
							folders need confirmation.
						</Caption>
						<Buttons>
							<Button
								kind="primary"
								label="Import repository"
								testID="import-start"
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
						</Buttons>
					</If>
				</If>
				<If when={message()}>
					<Caption testID="projects-message">{message()}</Caption>
				</If>
			</Block>
			<Rows>
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
						<Row
							title={`${i().url} · ${i().phase}`}
							meta={i().destination}
							selectable
							trailing={
								<>
									<If when={["interrupted", "failed", "cancelled"].includes(i().phase)}>
										<Button
											small
											label="Resume import"
											disabled={disabled()}
											onPress={() => void action({ action: "resume", importId: i().id })}
										/>
									</If>
									<If when={i().phase === "confirm_existing"}>
										<Button
											small
											label="Use this existing checkout"
											disabled={disabled()}
											onPress={() => void action({ action: "confirm_existing", importId: i().id })}
										/>
									</If>
									<If when={["queued", "cloning", "registering"].includes(i().phase)}>
										<Button
											small
											label="Cancel import"
											disabled={busy() || !snapshot()}
											onPress={() => void action({ action: "cancel_import", importId: i().id })}
										/>
									</If>
								</>
							}
							detail={
								<If when={i().problem}>
									<RowDetail>
										<Caption>{i().problem ?? ""}</Caption>
									</RowDetail>
								</If>
							}
						/>
					)}
				</Each>
			</Rows>
			<Block gap={3}>
				<If when={(snapshot()?.imports.length ?? 0) > PAGE_SIZE}>
					<Buttons>
						<Button
							small
							label="Newer imports"
							disabled={importPage() === 0}
							onPress={() => importPage.set(importPage() - 1)}
						/>
						<Button
							small
							label="Earlier imports"
							disabled={(importPage() + 1) * PAGE_SIZE >= (snapshot()?.imports.length ?? 0)}
							onPress={() => importPage.set(importPage() + 1)}
						/>
					</Buttons>
				</If>
				<Disclosure
					label={github() ? "Hide GitHub setup" : "GitHub access and SSH setup"}
					testID="github-setup-open"
					open={github()}
					onToggle={() => github.set(!github())}
				>
					<View class="gap-2">
						<Body>
							{snapshot()?.github.account
								? `GitHub account: ${snapshot()?.github.account}`
								: "GitHub access has not been checked."}
						</Body>
						<Caption>
							{snapshot()?.github.sshReady
								? `SSH verified (${snapshot()?.github.sshIdentity ?? "dedicated"}).`
								: "SSH is not verified. Existing credentials and configuration are kept."}
						</Caption>
						<If when={snapshot()?.github.problem}>
							<Body tone="muted">{snapshot()?.github.problem ?? ""}</Body>
						</If>
						<Buttons>
							<Button
								label="Check existing access"
								testID="github-verify"
								disabled={disabled()}
								onPress={() => void action({ action: "verify_existing" })}
							/>
							<Button
								label="Sign in to GitHub"
								disabled={disabled() || snapshot()?.github.apiReady}
								onPress={() => void action({ action: "authorize" })}
							/>
						</Buttons>
						<If when={snapshot()?.github.challenge}>
							<Quote
								text={`Open ${snapshot()?.github.challenge?.url} in your browser. Enter code ${snapshot()?.github.challenge?.code}.`}
							/>
							<Buttons>
								<Button
									label="Cancel sign-in"
									disabled={busy() || !snapshot()}
									onPress={() => void action({ action: "cancel" })}
								/>
							</Buttons>
						</If>
						<Buttons>
							<Button
								label="Prepare optional dedicated SSH key"
								disabled={disabled() || !snapshot()?.github.apiReady}
								onPress={() => void action({ action: "prepare_key" })}
							/>
						</Buttons>
						<If when={snapshot()?.github.fingerprint}>
							<Quote code text={`Dedicated key fingerprint: ${snapshot()?.github.fingerprint}`} />
							<Buttons>
								<Button
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
								<Button
									label="Check dedicated key"
									disabled={disabled()}
									onPress={() => void action({ action: "verify" })}
								/>
							</Buttons>
						</If>
					</View>
				</Disclosure>
			</Block>
		</Section>
	);
}

// LIBRARY GAP: `Checkbox` has no `tickTestID`, and tests read a project's allowed profiles by their tick. Until
// Checkbox shows its tick by test ID, this uses `Option multiple compact`, which does (and draws the same box).
function ProfileBox(props: {
	testID: string;
	tickTestID?: string;
	label: string;
	checked: boolean;
	disabled: boolean;
	onChange: () => void;
}) {
	return (
		<Option
			multiple
			compact
			title={props.label}
			testID={props.testID}
			tickTestID={props.tickTestID}
			checked={props.checked}
			disabled={props.disabled}
			onChange={props.onChange}
		/>
	);
}
