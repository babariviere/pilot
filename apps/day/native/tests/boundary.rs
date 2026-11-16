//! The boundary TSX sees: generated declarations and the one exported
//! class. A change here changes what the Today screen may do.

use nsh_core::element::declarations;

fn ts() -> String {
    declarations(&pilot_day_native::registry(), &[])
}

#[test]
fn the_screen_gets_typed_read_models_and_intents() {
    let ts = ts();
    for line in [
        "export type Delivery = \"idle\" | \"sending\" | \"unknown\" | \"checking\";",
        "export type MissionState = \"moving\" | \"notMoving\" | \"unreported\" | \"waiting\" | \"stuck\" | \"unconfirmed\" | \"pausing\" | \"paused\" | \"resuming\";",
        "export type ControlState = \"running\" | \"pausing\" | \"paused\" | \"resuming\" | \"unknown\";",
        "export type Currentness = \"current\" | \"stale\" | \"unavailable\";",
        "export type FreshnessState = \"live\" | \"stale\" | \"offline\" | \"unreadable\" | \"cached\" | \"unavailable\";",
        "  mission(missionId: string): MissionPage | null;",
        // A mission's overview only reads its detail again.
        "  openMission(intent: MissionRef): Promise<IntentOutcome>;",
        "  pause(intent: PauseIntent): Promise<IntentOutcome>;",
        "  resume(intent: ResumeIntent): Promise<IntentOutcome>;",
        "  checkControl(intent: MissionRef): Promise<IntentOutcome>;",
        "  decide(intent: DecideIntent): Promise<IntentOutcome>;",
        "  later(intent: DecisionRef): IntentOutcome;",
        "  check(intent: DecisionRef): Promise<IntentOutcome>;",
        "  ask(intent: AskIntent): Promise<IntentOutcome>;",
        "  checkAnswer(intent: AnswerRef): Promise<IntentOutcome>;",
        "  saveProgress(intent: ProgressIntent): Promise<IntentOutcome>;",
        "  actionLater(intent: ActionRef): Promise<IntentOutcome>;",
        "  complete(intent: CompleteIntent): Promise<IntentOutcome>;",
        "  checkAction(intent: ActionCheck): Promise<IntentOutcome>;",
        // Drafts and own words name the item and revision shown; a link is
        // opened by Rust from the daemon's pinned destination, never a URL.
        "  reply(intent: ReplyIntent): Promise<IntentOutcome>;",
        "  saveDraft(intent: DraftIntent): IntentOutcome;",
        "  openLink(intent: ActionRef): Promise<IntentOutcome>;",
        "export type AnswerState = \"asking\" | \"ready\" | \"unknown\" | \"checking\";",
        "export type ActionAsk = \"progress\" | \"later\" | \"complete\";",
        "  pulse(everyMs?: number | null, count?: number | null): Promise<number>;",
        "  onChange(listener: (today: Today) => void): () => void;",
        // Planning: drafts name the question shown; one explicit submission
        // names the saved revision shown; nothing here starts work.
        "  page(missionId: string): PlanPage | null;",
        "  open(missionId: string): Promise<PlanOutcome>;",
        "  plan(intent: NewIntent): Promise<PlanOutcome>;",
        "  prepareNew(): Promise<PlanOutcome>;",
        "  checkNew(): Promise<PlanOutcome>;",
        "  canCreate: boolean;",
        "  canStart: boolean;",
        "  startReason: string;",
        "  start(intent: NewIntent): Promise<PlanOutcome>;",
        "  saveAnswer(intent: AnswerIntent): Promise<PlanOutcome>;",
        "  submit(intent: SubmitIntent): Promise<PlanOutcome>;",
        "  checkSubmit(intent: InterviewRef): Promise<PlanOutcome>;",
        "  onChange(listener: (planning: Planning) => void): () => void;",
        "export type SubmitState = \"open\" | \"submitting\" | \"submitted\" | \"unknown\" | \"checking\";",
        "export type QuestionState = \"open\" | \"answered\" | \"changed\";",
        "export type StepState = \"waiting\" | \"now\" | \"done\" | \"unknown\" | \"unavailable\";",
        "  snapshot(): RitualSnapshot;",
        "  save(intent: RitualWrite): Promise<IntentOutcome>;",
        "  visit(intent: RitualVisit): Promise<IntentOutcome>;",
        "  refreshResults(): Promise<IntentOutcome>;",
        "export type RitualAvailability = \"unavailable\" | \"available\" | \"unknown\";",
        // Changes: reopening reads one exact snapshot; Later and Bring back
        // name the request revision shown; nothing here approves.
        "  change(snapshotId: string): ChangePage | null;",
        "  open(intent: ChangeRef): Promise<IntentOutcome>;",
        "  later(intent: AttentionIntent): Promise<IntentOutcome>;",
        "  bringBack(intent: AttentionIntent): Promise<IntentOutcome>;",
        "  checkAttention(intent: ChangeRef): Promise<IntentOutcome>;",
        "  more(): IntentOutcome;",
        // Read again only reads: it takes nothing and sends nothing.
        "  refresh(): IntentOutcome;",
        "  onChange(listener: (changes: ChangeList) => void): () => void;",
        "export type ChangeAttention = \"none\" | \"waiting\" | \"later\" | \"closed\" | \"unknown\";",
        // Updates: Rust prepares a one-use confirmation for the kind and
        // revision shown; confirming carries where the user is; a check
        // only reads. TSX never names a target, version, service or process.
        "  prepare(intent: PrepareIntent): Prepared;",
        "  confirm(intent: ConfirmIntent): Promise<IntentOutcome>;",
        "  cancel(intent: UpdateRef): IntentOutcome;",
        "  check(): Promise<IntentOutcome>;",
        "  restored(intent: UpdateRef): Promise<IntentOutcome>;",
        "  onChange(listener: (service: ServiceView) => void): () => void;",
        "export type UpdateKind = \"register\" | \"app\" | \"service\" | \"both\";",
        "export type UpdatePhase = \"running\" | \"done\" | \"stopped\" | \"unknown\" | \"checking\";",
        "export type ServiceState = \"registered\" | \"absent\" | \"offline\" | \"incompatible\" | \"unknown\";",
        "export type LandingState = \"unchecked\" | \"seen\" | \"notSeen\" | \"unclear\";",
        "export interface ChatChoice {",
        "  chat?: ChatChoice | null;",
        "  draftId: string;",
        "  projectId: string;",
        "  projectPath: string;",
        "  contextDigest: string;",
    ] {
        assert!(ts.contains(line), "missing {line:?} in\n{ts}");
    }
}

#[test]
fn exports_are_feeds_and_the_local_exporter_without_transport_or_paths() {
    let ts = ts();
    let mut values: Vec<&str> = ts
        .lines()
        .filter(|line| line.starts_with("export declare"))
        .collect();
    values.sort_unstable();
    assert_eq!(
        values,
        [
            "export declare class ArtifactExport {",
            "export declare class ChangesFeed {",
            "export declare class PlanFeed {",
            "export declare class RitualFeed {",
            "export declare class TodayFeed {",
            "export declare class UpdateFeed {"
        ],
        "{ts}"
    );
    assert!(ts.contains("  save(snapshot: string): Promise<string>;"));
    // Control commands are built in Rust: TSX names only the mission, the
    // revision it showed and, for Resume, the Pause it showed. It never sees
    // a home or a new operation it could forge. These existing read models
    // name display context, not authority for a control command. Allow only
    // these exact fields on their named types, never the same field on an intent.
    let mut without_read_context = ts.clone();
    for (name, field) in [
        ("ChatChoice", "  projectId: string;\n"),
        ("Problem", "  projectId: string;\n"),
        ("MissionPage", "  coordinatorSessionId?: string | null;\n"),
    ] {
        let header = format!("export interface {name} {{");
        let (before, rest) = without_read_context.split_once(&header).unwrap();
        let (body, after) = rest.split_once("\n}").unwrap();
        assert!(body.contains(field), "missing read context: {name}.{field}");
        without_read_context =
            format!("{before}{header}{}\n}}{after}", body.replacen(field, "", 1));
    }
    for word in [
        "url",
        "fetch",
        "socket",
        "daemon",
        "path",
        "token",
        "home",
        "lineage",
        "coordinatorsessionid",
        "expectedrevision",
    ] {
        assert!(
            ![":", "?:"].iter().any(|end| without_read_context
                .to_lowercase()
                .contains(&format!(" {word}{end}"))),
            "the boundary names {word:?}:\n{ts}"
        );
    }
    assert!(!without_read_context.to_lowercase().contains(" projectid:"));
    assert_eq!(
        pilot_day_native::registry().undocumented(),
        Vec::<String>::new()
    );
}
