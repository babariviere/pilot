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
        "export type MissionState = \"moving\" | \"waiting\" | \"stuck\" | \"unconfirmed\" | \"paused\" | \"later\";",
        "  decide(intent: DecideIntent): Promise<IntentOutcome>;",
        "  later(intent: DecisionRef): IntentOutcome;",
        "  check(intent: DecisionRef): Promise<IntentOutcome>;",
        "  ask(intent: AskIntent): Promise<IntentOutcome>;",
        "  onChange(listener: (today: Today) => void): () => void;",
    ] {
        assert!(ts.contains(line), "missing {line:?} in\n{ts}");
    }
}

#[test]
fn the_only_export_is_the_feed_and_it_has_no_transport() {
    let ts = ts();
    let values: Vec<&str> = ts
        .lines()
        .filter(|line| line.starts_with("export declare"))
        .collect();
    assert_eq!(values, ["export declare class TodayFeed {"], "{ts}");
    for word in ["url", "fetch", "socket", "daemon", "path", "token"] {
        assert!(
            !ts.to_lowercase().contains(&format!("{word}:")),
            "the boundary names {word:?}:\n{ts}"
        );
    }
    assert_eq!(
        pilot_day_native::registry().undocumented(),
        Vec::<String>::new()
    );
}
