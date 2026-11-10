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
    ] {
        assert!(ts.contains(line), "missing {line:?} in\n{ts}");
    }
}

#[test]
fn the_only_exports_are_the_feeds_and_they_have_no_transport() {
    let ts = ts();
    let mut values: Vec<&str> = ts
        .lines()
        .filter(|line| line.starts_with("export declare"))
        .collect();
    values.sort_unstable();
    assert_eq!(
        values,
        [
            "export declare class ChangesFeed {",
            "export declare class PlanFeed {",
            "export declare class RitualFeed {",
            "export declare class TodayFeed {",
            "export declare class UpdateFeed {"
        ],
        "{ts}"
    );
    // Control commands are built in Rust: TSX names only the mission, the
    // revision it showed and, for Resume, the Pause it showed. It never sees
    // a home, project, coordinator or a new operation it could forge.
    for word in [
        "url",
        "fetch",
        "socket",
        "daemon",
        "path",
        "token",
        "home",
        "lineage",
        "projectid",
        "coordinatorsessionid",
        "expectedrevision",
    ] {
        assert!(
            ![":", "?:"]
                .iter()
                .any(|end| ts.to_lowercase().contains(&format!(" {word}{end}"))),
            "the boundary names {word:?}:\n{ts}"
        );
    }
    assert_eq!(
        pilot_day_native::registry().undocumented(),
        Vec::<String>::new()
    );
}
