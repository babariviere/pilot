//! The mock worlds behind the Today spike. Every name, number and event is
//! invented and matches the D prototype's synthetic data. A Rust-only Today
//! screen can render the same [`Today`] values for a like-for-like
//! comparison.

use crate::model::{
    Decision, DecisionKind, DecisionOption, Delivery, DoneEntry, Evidence, MissionRow,
    MissionState, Progress, Scenario, Scheduled, Today, Tone,
};

/// How the mock coordinator answers a sent decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ack {
    /// It confirms the answer.
    Confirm,
    /// Its confirmation is lost: the outcome stays unknown until checked.
    Lose,
}

/// A mock world: the read model, how each decision is acknowledged, and the
/// canned answers to questions.
#[derive(Debug, Clone)]
pub struct World {
    /// The read model at the start.
    pub today: Today,
    /// How the mock coordinator answers each decision, by id.
    pub acks: Vec<(String, Ack)>,
    /// The canned answer to any question about a decision, by id.
    pub answers: Vec<(String, String)>,
}

/// The world for `scenario`.
pub fn world(scenario: Scenario) -> World {
    match scenario {
        Scenario::Decisions => decisions(),
        Scenario::Quiet => quiet(),
        Scenario::Trouble => trouble(),
        Scenario::Large => large(200, 120),
    }
}

/// The read model for `scenario`, for a Rust screen or a test.
pub fn today(scenario: Scenario) -> Today {
    world(scenario).today
}

fn s(text: &str) -> String {
    text.to_owned()
}

fn lines(items: &[&str]) -> Vec<String> {
    items.iter().map(|line| s(line)).collect()
}

fn ev(label: &str) -> Evidence {
    Evidence {
        label: s(label),
        tone: Tone::Neutral,
    }
}

fn ev_tone(label: &str, tone: Tone) -> Evidence {
    Evidence {
        label: s(label),
        tone,
    }
}

fn opt(id: &str, label: &str, detail: &str, recommended: bool) -> DecisionOption {
    DecisionOption {
        id: s(id),
        label: s(label),
        detail: s(detail),
        recommended,
    }
}

fn progress(done: u32, review: u32, active: u32, blocked: u32, todo: u32) -> Progress {
    Progress {
        done,
        review,
        active,
        blocked,
        todo,
    }
}

fn mission(
    id: &str,
    title: &str,
    state: MissionState,
    line: &str,
    decision_id: Option<&str>,
    stage: &str,
    progress: Progress,
) -> MissionRow {
    MissionRow {
        id: s(id),
        title: s(title),
        state,
        line: s(line),
        decision_id: decision_id.map(s),
        stage: s(stage),
        progress,
    }
}

fn done(id: &str, text: &str, mission_title: &str, evidence: Vec<Evidence>) -> DoneEntry {
    DoneEntry {
        id: s(id),
        text: s(text),
        mission_title: s(mission_title),
        evidence,
    }
}

fn scheduled(id: &str, text: &str, when: &str, note: Option<&str>) -> Scheduled {
    Scheduled {
        id: s(id),
        text: s(text),
        when: s(when),
        note: note.map(s),
    }
}

fn base_done() -> Vec<DoneEntry> {
    vec![
        done(
            "d5",
            "Tidy shell setup finished. Shell starts in 84 ms, was 310 ms.",
            "Tidy shell setup",
            vec![ev("3 commits"), ev("Startup timing")],
        ),
        done(
            "d1",
            "Older messages now load while a reply streams.",
            "Native desktop app",
            vec![ev("a41c9e2"), ev("38 tests passed")],
        ),
        done(
            "d4",
            "Search index rebuilds 4x faster. Median search is 150 ms.",
            "Faster search",
            vec![ev("Benchmark chart")],
        ),
    ]
}

fn base_coming_up() -> Vec<Scheduled> {
    vec![
        scheduled("s1", "Daily summary from all coordinators", "18:00", None),
        scheduled(
            "s2",
            "Re-run the search benchmark",
            "Nightly 02:00",
            Some("Set by Pilot for Faster search. Catches slowdowns from other changes."),
        ),
        scheduled(
            "s3",
            "Weekly Insights report for pilot",
            "Tomorrow 09:00",
            None,
        ),
    ]
}

fn search_moving() -> MissionRow {
    mission(
        "search",
        "Faster search",
        MissionState::Moving,
        "Running integration tests on Linux.",
        None,
        "Stage 3 of 4 · Verify",
        progress(7, 0, 1, 0, 2),
    )
}

fn decision(id: &str, kind: DecisionKind, mission_id: &str, mission_title: &str) -> Decision {
    Decision {
        id: s(id),
        revision: 1,
        kind,
        mission_id: s(mission_id),
        mission_title: s(mission_title),
        delivery: if kind == DecisionKind::Unknown {
            Delivery::Unknown
        } else {
            Delivery::Idle
        },
        ..Decision::default()
    }
}

fn decisions() -> World {
    let q1 = Decision {
        title: s("How should finished work reach you?"),
        reason: s("Asks: notification rule"),
        effort: s("About 1 min"),
        context: s(
            "Last week Pilot sent 41 notifications. 6 needed you. The rest were finished work you looked at later.",
        ),
        simpler: s(
            "Pilot sends too many notifications. Choose when it should tell you about finished work.",
        ),
        more: lines(&[
            "35 of the 41 notifications were finished work. You opened most of them hours later.",
            "Questions and failures still notify you right away with every option.",
            "You can change this later in Settings, under Notifications.",
        ]),
        boundary: s(
            "Changing which events notify you is outside the agreed scope, so the coordinator stopped to ask.",
        ),
        options: vec![
            opt(
                "a",
                "One summary at 18:00",
                "Fewer interruptions. Failures and questions still notify right away.",
                true,
            ),
            opt("b", "Each finished task", "Same as today.", false),
            opt(
                "c",
                "Only failures and questions",
                "Finished work waits in Pilot until you look.",
                false,
            ),
        ],
        evidence: vec![ev("Notification chart"), ev("Audit notes")],
        ..decision(
            "q1",
            DecisionKind::Choice,
            "notify",
            "Quieter notifications",
        )
    };
    let q2 = Decision {
        title: s("Open a test copy of Pilot on your Mac?"),
        reason: s("Approval: open an app"),
        effort: s("Under a minute"),
        context: s(
            "The image zoom checks need a real window. Pilot would open a separate test copy with its own data, then close it.",
        ),
        simpler: s(
            "To test image zoom for real, Pilot needs to open a second Pilot window with fake data. Is that OK?",
        ),
        more: lines(&[
            "The test copy has its own data folder. It cannot see your chats or missions.",
            "It runs for about 4 minutes, then Pilot closes it.",
            "If you skip it, only synthetic tests check zoom, so how it feels stays unchecked.",
        ]),
        boundary: s("Opening apps on your Mac needs your approval."),
        options: vec![
            opt(
                "a",
                "Allow for this check",
                "Opens once, with test data only. Your Pilot keeps running.",
                true,
            ),
            opt(
                "b",
                "Skip it",
                "Uses synthetic checks only. How zoom feels stays unchecked.",
                false,
            ),
        ],
        evidence: vec![ev("Check plan")],
        ..decision("q2", DecisionKind::Approval, "native", "Native desktop app")
    };
    let r1 = Decision {
        title: s("Review: History slice"),
        reason: s("Ready for review"),
        effort: s("About 2 min"),
        context: s("Older messages load while streaming. Reading position holds."),
        simpler: s(
            "Scrolling up now loads older messages without jumping. Pilot wants your OK to call it done.",
        ),
        more: lines(&[
            "38 tests passed, including 12 capture runs.",
            "You asked yesterday that the reading position stays put. All 12 runs kept it.",
        ]),
        boundary: s("Finished work needs your review before it counts as done."),
        options: vec![opt(
            "approve",
            "Approve",
            "Marks the history slice done.",
            true,
        )],
        evidence: vec![
            ev("38 tests passed"),
            ev("4 files changed"),
            ev("Capture, light and dark"),
        ],
        ..decision("r1", DecisionKind::Review, "native", "Native desktop app")
    };
    let today = Today {
        revision: 1,
        date_line: s("Monday 9 November, 11:02"),
        headline: s("Three short things need you."),
        summary: s(
            "Quieter notifications needs a rule choice. The native app wants to open a test copy of Pilot. Search is still testing.",
        ),
        left_off: Some(s(
            "You were reading the history slice in Native desktop app.",
        )),
        notes: Vec::new(),
        decisions: vec![q1, q2, r1],
        moving: vec![search_moving()],
        not_moving: vec![
            mission(
                "native",
                "Native desktop app",
                MissionState::Waiting,
                "Paused before the macOS checks: waiting for your OK to open a test copy of Pilot.",
                Some("q2"),
                "Stage 2 of 5 · History and images",
                progress(14, 1, 2, 0, 6),
            ),
            mission(
                "notify",
                "Quieter notifications",
                MissionState::Waiting,
                "Waiting for your choice on notification rules.",
                Some("q1"),
                "Stage 2 of 4 · Rules",
                progress(4, 0, 0, 1, 3),
            ),
        ],
        last_looked: s("at 09:15"),
        done: base_done(),
        done_hidden: 0,
        finished: vec![s("Tidy shell setup")],
        coming_up: base_coming_up(),
    };
    World {
        today,
        acks: vec![
            (s("q1"), Ack::Confirm),
            (s("q2"), Ack::Confirm),
            (s("r1"), Ack::Confirm),
        ],
        answers: vec![
            (
                s("q1"),
                s(
                    "Anything that finishes after 18:00 waits for the next day's summary. Questions and failures still reach you right away.",
                ),
            ),
            (
                s("q2"),
                s("No. The test copy has its own data and never touches your Pilot or its daemon."),
            ),
            (
                s("r1"),
                s("Yes. Light and dark captures are attached to the result."),
            ),
        ],
    }
}

fn quiet() -> World {
    let today = Today {
        revision: 1,
        date_line: s("Monday 9 November, 09:12"),
        headline: s("Nothing needs you today."),
        summary: s(
            "Overnight, Tidy shell setup finished and the native app moved on to images. Faster search is running its last checks.",
        ),
        left_off: Some(s(
            "You were reading the history slice in Native desktop app.",
        )),
        notes: Vec::new(),
        decisions: Vec::new(),
        moving: vec![
            mission(
                "native",
                "Native desktop app",
                MissionState::Moving,
                "Checking image zoom on a 4K capture.",
                None,
                "Stage 2 of 5 · History and images",
                progress(14, 1, 2, 0, 6),
            ),
            search_moving(),
        ],
        not_moving: vec![mission(
            "notify",
            "Quieter notifications",
            MissionState::Later,
            "Starts Rules this afternoon.",
            None,
            "Stage 2 of 4 · Rules",
            progress(3, 0, 0, 0, 5),
        )],
        last_looked: s("yesterday at 19:05"),
        done: base_done(),
        done_hidden: 0,
        finished: vec![s("Tidy shell setup")],
        coming_up: base_coming_up(),
    };
    World {
        today,
        acks: Vec::new(),
        answers: Vec::new(),
    }
}

fn trouble() -> World {
    let f1 = Decision {
        title: s("2 integration tests fail on Linux"),
        reason: s("Failed: 2 of 148 tests"),
        effort: s("About 2 min"),
        context: s("Both failures started with the incremental index (7c1e04a). macOS passes."),
        simpler: s(
            "Two Linux tests fail because results come back in a different order. The clean fix adds a sort option to the search API.",
        ),
        more: lines(&[
            "macOS and Linux sort equal scores differently. The tests expect the macOS order.",
            "Option 1 adds an optional sort setting. Callers that do not use it see no change.",
            "Option 2 keeps the API but sorts every search inside the index, about 20 ms slower.",
        ]),
        boundary: s("Changing the public search API is outside the agreed scope."),
        tried: lines(&[
            "Re-ran the Linux tests once. Same 2 failures.",
            "Found the cause: results are ordered differently on Linux.",
            "A fix would change the public search API, so it stopped.",
        ]),
        options: vec![
            opt(
                "a",
                "Allow the API change for this fix",
                "Adds a stable sort option. Callers keep working.",
                true,
            ),
            opt(
                "b",
                "Keep the API; sort inside the index",
                "About 20 ms slower. No API change.",
                false,
            ),
            opt(
                "c",
                "Pause the mission",
                "Nothing changes until you resume it.",
                false,
            ),
        ],
        evidence: vec![
            ev_tone("2 failing tests", Tone::Bad),
            ev("7c1e04a"),
            ev("Linux test output"),
        ],
        ..decision("f1", DecisionKind::Failure, "search", "Faster search")
    };
    let u1 = Decision {
        title: s("Push not confirmed"),
        reason: s("Unconfirmed: push of image zoom"),
        effort: s("Under a minute"),
        context: s(
            "The remote did not answer after pushing \"Image zoom and pan\". Pilot does not know if it landed.",
        ),
        simpler: s(
            "Pilot pushed code, but GitHub did not reply. Pilot wants to check that it arrived before doing anything else.",
        ),
        more: lines(&[
            "Pushing again without checking could create a duplicate.",
            "Check again only reads the branch. It changes nothing.",
        ]),
        boundary: s("Pushing twice could duplicate work, so Pilot waits."),
        tried: lines(&[
            "Waited 35 seconds for an answer.",
            "Will not push again until it can confirm.",
        ]),
        evidence: vec![ev_tone("e93b1a0", Tone::Warn)],
        details: Some(s("Commit e93b1a0, 6 files, \"Image zoom and pan\".")),
        ..decision("u1", DecisionKind::Unknown, "native", "Native desktop app")
    };
    let mut coming_up = vec![scheduled(
        "s0",
        "Check again whether the image zoom push landed",
        "17:30",
        Some("Set by Pilot for Native desktop app. Checking only reads."),
    )];
    coming_up.extend(base_coming_up());
    let today = Today {
        revision: 1,
        date_line: s("Monday 9 November, 16:48"),
        headline: s("One check failed. One push is unconfirmed."),
        summary: s(
            "Faster search stopped on 2 Linux test failures and needs a choice. The native app is waiting to confirm a push. Notifications paused until 18:00.",
        ),
        left_off: None,
        notes: Vec::new(),
        decisions: vec![f1, u1],
        moving: Vec::new(),
        not_moving: vec![
            mission(
                "search",
                "Faster search",
                MissionState::Stuck,
                "Stopped: 2 integration tests fail on Linux.",
                Some("f1"),
                "Stage 3 of 4 · Verify",
                progress(7, 0, 0, 1, 2),
            ),
            mission(
                "native",
                "Native desktop app",
                MissionState::Unconfirmed,
                "Waiting to confirm a push before continuing.",
                Some("u1"),
                "Stage 2 of 5 · History and images",
                progress(14, 1, 2, 0, 6),
            ),
            mission(
                "notify",
                "Quieter notifications",
                MissionState::Paused,
                "Paused: usage limit reached. Resumes at 18:00.",
                None,
                "Stage 2 of 4 · Rules",
                progress(3, 0, 1, 0, 4),
            ),
        ],
        last_looked: s("at 13:30"),
        done: vec![
            done(
                "t1",
                "Linux tests failed after the index change. macOS passed.",
                "Faster search",
                vec![ev_tone("2 failing tests", Tone::Bad)],
            ),
            done(
                "t2",
                "Image zoom and pan finished. Its push is not confirmed yet.",
                "Native desktop app",
                vec![ev_tone("e93b1a0", Tone::Warn)],
            ),
            done(
                "t3",
                "Paused at the usage limit. Resumes at 18:00.",
                "Quieter notifications",
                Vec::new(),
            ),
        ],
        done_hidden: 0,
        finished: vec![s("Tidy shell setup")],
        coming_up,
    };
    World {
        today,
        // The failure's answer is sent, but its confirmation is lost.
        acks: vec![(s("f1"), Ack::Lose)],
        answers: vec![
            (
                s("f1"),
                s("Callers that do not pass the new option get exactly the same results as today."),
            ),
            (
                s("u1"),
                s(
                    "If it did not land, Pilot pushes once more, then tells you. It never pushes twice without checking.",
                ),
            ),
        ],
    }
}

/// The decisions world with `missions` more missions and `results` more
/// results since the user looked, for scrolling, memory and update checks.
pub fn large(missions: u32, results: u32) -> World {
    let mut world = decisions();
    let today = &mut world.today;
    for n in 0..missions {
        let row = mission(
            &format!("m{n}"),
            &format!("Generated mission {n}"),
            if n % 3 == 0 {
                MissionState::Paused
            } else {
                MissionState::Moving
            },
            &format!("Working on step {} of a generated plan.", n % 7 + 1),
            None,
            &format!("Stage {} of 4 · Generated", n % 4 + 1),
            progress(n % 9, n % 2, 1, 0, 3),
        );
        if row.state == MissionState::Moving {
            today.moving.push(row);
        } else {
            today.not_moving.push(row);
        }
    }
    for n in 0..results {
        today.done.push(done(
            &format!("g{n}"),
            &format!("Generated result {n} landed with its checks."),
            &format!("Generated mission {}", n % missions.max(1)),
            vec![ev(&format!("{n:07x}")), ev("Checks passed")],
        ));
    }
    crate::desk::limit_done(today);
    world
}
