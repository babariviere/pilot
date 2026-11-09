//! The mock worlds behind the Today screen. Every name, number and event is
//! invented and matches the D prototype's synthetic data. Missions arrive as
//! the daemon's v1 contracts (`DayOverview`, `MissionDetail`), so the same
//! projection serves mock and real reads. A Rust-only Today screen can render
//! the same [`Today`] values for a like-for-like comparison.

use crate::{
    contract::{
        Control, ControlState, Currentness, Dashboard, DashboardMission, DayOverview, Home,
        MissionDetail, MissionHead, Movement, Phase, Provenance, Report, ReportView, ReportWrite,
        Section, Task, TaskStatus, WorkingItem,
    },
    model::{
        Decision, DecisionKind, DecisionOption, Delivery, DoneEntry, Evidence, FreshnessState,
        Scenario, Scheduled, Today, Tone,
    },
    project::MINUTE,
};

/// The mock clock: every world is read at this instant (epoch ms).
pub const NOW: u64 = 1_794_229_320_000;

/// The mock project.
pub const PROJECT: &str = "mock-project";

/// The mock home every control command is pinned to.
pub fn home() -> Home {
    Home {
        daemon_id: s("mock-daemon"),
        lineage_id: s("mock-lineage"),
    }
}

/// How the mock coordinator answers a sent decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ack {
    /// It confirms the answer.
    Confirm,
    /// Its confirmation is lost: the outcome stays unknown until checked.
    Lose,
}

/// How the mock daemon answers a Pause or Resume.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ControlAck {
    /// Every member reaches a safe point; the operation is acknowledged.
    #[default]
    Acknowledge,
    /// One member's outcome is unknown; the operation needs a look.
    Inspect,
    /// The operation is acknowledged, but the answer never arrives.
    Lose,
}

/// A mock world: the read model, the daemon's reads behind it, how each
/// decision and control is acknowledged, and the canned answers.
#[derive(Debug, Clone)]
pub struct World {
    /// The read model at the start, without missions: those are projected
    /// from `overview`.
    pub today: Today,
    /// The latest `DayOverview`. None when nothing could be read.
    pub overview: Option<DayOverview>,
    /// Mission details the overview page can show.
    pub details: Vec<MissionDetail>,
    /// Whether the read is live, and if not, why.
    pub freshness: (FreshnessState, &'static str),
    /// How the mock coordinator answers each decision, by id.
    pub acks: Vec<(String, Ack)>,
    /// How the mock daemon answers a control, by mission id.
    pub control_acks: Vec<(String, ControlAck)>,
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
        Scenario::Offline => offline(),
        Scenario::Unreadable => unreadable(),
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

/// A dashboard mission: tasks done, in review, in progress, blocked and in
/// total, and member chats working now.
fn dash(id: &str, title: &str, counts: [u32; 5], working: u32, needs_you: u32) -> DashboardMission {
    let [done, review, active, blocked, total] = counts;
    DashboardMission {
        id: s(id),
        title: s(title),
        tasks_done: done,
        tasks_in_review: review,
        tasks_in_progress: active,
        tasks_blocked: blocked,
        tasks_total: total,
        working,
        needs_you,
        coordinator_session_id: Some(format!("c-{id}")),
    }
}

/// A saved report, as the daemon returns it.
pub struct ReportSpec<'a> {
    /// The mission.
    pub mission: &'a str,
    /// The task it reports on.
    pub task: &'a str,
    /// The reporting chat. `c-<mission>` is the coordinator.
    pub by: &'a str,
    /// Minutes before [`NOW`].
    pub minutes_ago: u64,
    /// The agent's assessment.
    pub movement: Movement,
    /// Whether it is current.
    pub currentness: Currentness,
    /// The agent's summary.
    pub summary: &'a str,
    /// The agent's next step.
    pub next: &'a str,
    /// References the agent named.
    pub evidence: &'a [&'a str],
}

/// The daemon's view of a report.
pub fn report(spec: &ReportSpec) -> ReportView {
    let at = NOW - spec.minutes_ago * MINUTE;
    ReportView {
        report: Report {
            version: 1,
            mission_id: s(spec.mission),
            project_id: s(PROJECT),
            session_id: s(spec.by),
            coordinator_session_id: Some(format!("c-{}", spec.mission)),
            reported_at: at,
            valid_until: at + 24 * 60 * MINUTE,
            write: ReportWrite {
                version: 1,
                report_id: format!("r-{}-{}-{at}", spec.mission, spec.task),
                task_id: s(spec.task),
                movement: spec.movement,
                summary: s(spec.summary),
                next_step: s(spec.next),
                evidence: lines(spec.evidence),
            },
        },
        currentness: spec.currentness,
        provenance: Provenance::AgentReport,
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "a fixture row: every report field in order"
)]
fn current(
    mission: &str,
    task: &str,
    by: &str,
    minutes_ago: u64,
    movement: Movement,
    summary: &str,
    next: &str,
    evidence: &[&str],
) -> ReportView {
    report(&ReportSpec {
        mission,
        task,
        by,
        minutes_ago,
        movement,
        currentness: Currentness::Current,
        summary,
        next,
        evidence,
    })
}

/// A running control at revision 0, as a new mission has.
fn running(mission: &str) -> Control {
    Control {
        version: 1,
        mission_id: s(mission),
        revision: 0,
        pause_generation: 0,
        stop_generation: 0,
        held: false,
        state: ControlState::Running,
        operation_id: None,
        pause_operation_id: None,
    }
}

/// A control an earlier, acknowledged Pause `operation` holds.
fn paused(mission: &str, operation: &str) -> Control {
    Control {
        revision: 2,
        pause_generation: 1,
        held: true,
        state: ControlState::Paused,
        operation_id: Some(s(operation)),
        pause_operation_id: Some(s(operation)),
        ..running(mission)
    }
}

fn working(session: &str, title: &str, mission: &str, minutes_ago: u64) -> WorkingItem {
    WorkingItem {
        session_id: s(session),
        title: s(title),
        mission_id: Some(s(mission)),
        started_at: NOW - minutes_ago * MINUTE,
    }
}

fn overview(
    missions: Vec<DashboardMission>,
    working: Vec<WorkingItem>,
    reports: Vec<ReportView>,
    controls: Vec<Control>,
) -> DayOverview {
    DayOverview {
        version: 1,
        project_id: s(PROJECT),
        observed_at: NOW,
        complete: true,
        dashboard: Dashboard {
            missions: Section {
                total: missions.len() as u32,
                items: missions,
            },
            working: Section {
                total: working.len() as u32,
                items: working,
            },
        },
        reports,
        controls,
    }
}

fn task(id: &str, number: u32, title: &str, status: TaskStatus, session: Option<&str>) -> Task {
    Task {
        id: s(id),
        number,
        title: s(title),
        status,
        session_id: session.map(s),
        order: f64::from(number),
    }
}

fn detail(
    id: &str,
    title: &str,
    goal: &str,
    phase: (&str, u32, u32),
    tasks: Vec<Task>,
) -> MissionDetail {
    MissionDetail {
        mission: MissionHead {
            id: s(id),
            title: s(title),
            goal: s(goal),
            coordinator_session_id: Some(format!("c-{id}")),
            current_phase: Some(Phase {
                name: s(phase.0),
                done: phase.1,
                total: phase.2,
            }),
        },
        tasks,
    }
}

fn search_detail() -> MissionDetail {
    detail(
        "search",
        "Faster search",
        "Show search results in under 200 ms for large workspaces.",
        ("Verify", 0, 2),
        vec![
            task(
                "search-1",
                1,
                "Measure the baseline",
                TaskStatus::Done,
                None,
            ),
            task("search-2", 2, "Incremental index", TaskStatus::Done, None),
            task(
                "search-3",
                3,
                "Integration tests on Linux",
                TaskStatus::InProgress,
                Some("w-search"),
            ),
            task(
                "search-4",
                4,
                "Release pull request",
                TaskStatus::Todo,
                None,
            ),
        ],
    )
}

fn native_detail() -> MissionDetail {
    detail(
        "native",
        "Native desktop app",
        "Replace the desktop app with a native one that keeps every chat and draft.",
        ("History and images", 1, 3),
        vec![
            task("native-1", 1, "Shell and window", TaskStatus::Done, None),
            task("native-2", 2, "Chat view", TaskStatus::Done, None),
            task("native-3", 3, "Input and drafts", TaskStatus::Done, None),
            task(
                "native-4",
                4,
                "History slice",
                TaskStatus::InReview,
                Some("w-history"),
            ),
            task(
                "native-5",
                5,
                "Image zoom",
                TaskStatus::InProgress,
                Some("w-zoom"),
            ),
            task("native-6", 6, "Find in chat", TaskStatus::Todo, None),
        ],
    )
}

fn search_moving() -> ReportView {
    current(
        "search",
        "search-3",
        "w-search",
        12,
        Movement::Moving,
        "Running integration tests on Linux.",
        "Fix anything that fails, then open the release pull request.",
        &["7c1e04a", "Benchmark chart"],
    )
}

fn notify_counts() -> DashboardMission {
    dash("notify", "Quieter notifications", [4, 0, 0, 1, 8], 0, 1)
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
        last_looked: s("at 09:15"),
        done: base_done(),
        done_hidden: 0,
        finished: vec![s("Tidy shell setup")],
        coming_up: base_coming_up(),
        ..Today::default()
    };
    let overview = overview(
        vec![
            dash("native", "Native desktop app", [3, 1, 1, 0, 6], 0, 1),
            notify_counts(),
            dash("search", "Faster search", [2, 0, 1, 0, 4], 1, 0),
            dash("docs", "Docs refresh", [0, 0, 1, 0, 5], 1, 0),
        ],
        vec![
            working("w-search", "Integration tests on Linux", "search", 34),
            working("c-docs", "Docs refresh coordinator", "docs", 5),
        ],
        vec![
            current(
                "native",
                "native-5",
                "c-native",
                8,
                Movement::NotMoving,
                "Paused before the macOS checks: waiting for your OK to open a test copy of Pilot.",
                "Run the image zoom checks once you allow it.",
                &[],
            ),
            current(
                "native",
                "native-4",
                "w-history",
                95,
                Movement::NotMoving,
                "History slice is done and waits for your review.",
                "Start Find in chat after the review.",
                &["38 tests passed", "a41c9e2"],
            ),
            current(
                "notify",
                "notify-3",
                "c-notify",
                20,
                Movement::NotMoving,
                "Waiting for your choice on notification rules.",
                "Write the rule once you choose.",
                &["Notification chart"],
            ),
            search_moving(),
        ],
        vec![
            running("native"),
            running("notify"),
            running("search"),
            running("docs"),
        ],
    );
    World {
        today,
        overview: Some(overview),
        details: vec![search_detail(), native_detail()],
        freshness: (FreshnessState::Live, ""),
        control_acks: Vec::new(),
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
        last_looked: s("yesterday at 19:05"),
        done: base_done(),
        done_hidden: 0,
        finished: vec![s("Tidy shell setup")],
        coming_up: base_coming_up(),
        ..Today::default()
    };
    let notify = report(&ReportSpec {
        mission: "notify",
        task: "notify-3",
        by: "c-notify",
        minutes_ago: 40,
        movement: Movement::Moving,
        currentness: Currentness::Unavailable,
        summary: "Starts the rule editor this afternoon.",
        next: "Write the rule editor.",
        evidence: &[],
    });
    let overview = overview(
        vec![
            dash("native", "Native desktop app", [3, 1, 1, 0, 6], 1, 0),
            dash("search", "Faster search", [2, 0, 1, 0, 4], 1, 0),
            dash("notify", "Quieter notifications", [3, 0, 0, 0, 8], 0, 0),
        ],
        vec![
            working("w-zoom", "Image zoom", "native", 22),
            working("w-search", "Integration tests on Linux", "search", 34),
        ],
        vec![
            current(
                "native",
                "native-5",
                "w-zoom",
                6,
                Movement::Moving,
                "Checking image zoom on a 4K capture.",
                "Compare light and dark captures.",
                &["Capture, light and dark"],
            ),
            search_moving(),
            notify,
        ],
        vec![running("native"), running("search"), running("notify")],
    );
    World {
        today,
        overview: Some(overview),
        details: vec![search_detail(), native_detail()],
        freshness: (FreshnessState::Live, ""),
        acks: Vec::new(),
        control_acks: Vec::new(),
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
            "Faster search stopped on 2 Linux test failures and needs a choice. The native app is waiting to confirm a push. You paused Quieter notifications.",
        ),
        left_off: None,
        notes: Vec::new(),
        decisions: vec![f1, u1],
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
        ],
        done_hidden: 0,
        finished: vec![s("Tidy shell setup")],
        coming_up,
        ..Today::default()
    };
    let notify = report(&ReportSpec {
        mission: "notify",
        task: "notify-3",
        by: "c-notify",
        minutes_ago: 26 * 60,
        movement: Movement::Moving,
        currentness: Currentness::Stale,
        summary: "Writing the rule editor.",
        next: "Show the rule editor for review.",
        evidence: &[],
    });
    let overview = overview(
        vec![
            dash("search", "Faster search", [2, 0, 0, 1, 4], 0, 1),
            dash("native", "Native desktop app", [3, 1, 1, 0, 6], 1, 1),
            dash("notify", "Quieter notifications", [3, 0, 1, 0, 8], 0, 0),
            dash("release", "Release notes", [1, 0, 1, 0, 3], 1, 0),
        ],
        vec![
            working("w-zoom", "Image zoom", "native", 50),
            working("w-release", "Draft the 1.124 notes", "release", 9),
        ],
        vec![
            current(
                "search",
                "search-3",
                "c-search",
                14,
                Movement::NotMoving,
                "Stopped: 2 integration tests fail on Linux.",
                "Fix the order once you choose how.",
                &["2 failing tests", "Linux test output"],
            ),
            current(
                "native",
                "native-5",
                "c-native",
                21,
                Movement::NotMoving,
                "Waiting to confirm a push before continuing.",
                "Check that e93b1a0 landed, then go on with Find.",
                &["e93b1a0"],
            ),
            notify,
            current(
                "release",
                "release-2",
                "w-release",
                3,
                Movement::Moving,
                "Drafting notes for 1.124.",
                "Send the draft for review.",
                &[],
            ),
        ],
        vec![
            running("search"),
            running("native"),
            paused("notify", "op-earlier"),
            running("release"),
        ],
    );
    World {
        today,
        overview: Some(overview),
        details: vec![search_detail(), native_detail()],
        freshness: (FreshnessState::Live, ""),
        // A Pause of the native app leaves one chat unknown; a Pause of the
        // release notes is acknowledged, but the answer is lost.
        control_acks: vec![
            (s("native"), ControlAck::Inspect),
            (s("release"), ControlAck::Lose),
        ],
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
    let overview = world
        .overview
        .as_mut()
        .expect("the decisions world has a read");
    for n in 0..missions {
        let id = format!("m{n}");
        let mut mission = dash(
            &id,
            &format!("Generated mission {n}"),
            [n % 9, n % 2, 1, 0, n % 9 + n % 2 + 4],
            1,
            0,
        );
        mission.coordinator_session_id = Some(format!("c-{id}"));
        overview.dashboard.missions.items.push(mission);
        overview.reports.push(current(
            &id,
            &format!("{id}-1"),
            &format!("w-{id}"),
            u64::from(n % 50),
            Movement::Moving,
            &format!("Working on step {} of a generated plan.", n % 7 + 1),
            "Go on with the next step.",
            &[],
        ));
        overview.controls.push(if n % 3 == 0 {
            paused(&id, &format!("op-{id}"))
        } else {
            running(&id)
        });
    }
    overview.dashboard.missions.total = overview.dashboard.missions.items.len() as u32;
    let today = &mut world.today;
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

/// The decisions world, read 6 minutes ago; the service has not answered since.
fn offline() -> World {
    let mut world = decisions();
    if let Some(overview) = world.overview.as_mut() {
        overview.observed_at = NOW - 6 * MINUTE;
    }
    world.freshness = (FreshnessState::Offline, "Pilot's service is not answering.");
    world
}

/// Nothing could be read, and no earlier read exists.
fn unreadable() -> World {
    World {
        today: Today {
            revision: 1,
            date_line: s("Monday 9 November, 11:02"),
            ..Today::default()
        },
        overview: None,
        details: Vec::new(),
        freshness: (
            FreshnessState::Unreadable,
            "Pilot's service did not answer.",
        ),
        acks: Vec::new(),
        control_acks: Vec::new(),
        answers: Vec::new(),
    }
}
