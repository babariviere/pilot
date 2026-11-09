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
            "export declare class PlanFeed {",
            "export declare class TodayFeed {"
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
