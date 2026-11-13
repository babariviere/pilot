//! The mock worlds behind New, interviews and planning. Every name and
//! question is invented. The mock coordinator's steps ([`advance`]) stand in
//! for the real coordinator, which uses the trusted upstream planning skills.

use crate::plan::{
    Exploration, ExploreKind, ExploreState, FogArea, MapInfo, PauseNeed, PlanAvailability,
    PlanRoute, PlanScenario, Proposal, QuestionSection as S, RoundKind, RoundLine, RoundState,
    Setup, Slice, SliceOwner, Spec, StepState, Story,
};
use crate::plan_desk::{Ask, Plan, PlanWorld, Round, Script, SubmitAck, digest};
use crate::plan_revisit as revisit;

/// An earlier, submitted round of `asks`, each answered as given.
fn submitted_round(
    id: &str,
    title: &str,
    asks: Vec<Ask>,
    answers: &[(&str, Option<&str>, &str)],
) -> RoundLine {
    let asks: Vec<Ask> = asks
        .into_iter()
        .map(|a| match answers.iter().find(|(q, _, _)| *q == a.id) {
            Some((_, choice, text)) => a.answer(*choice, text),
            None => a,
        })
        .collect();
    let round = Round::new(id, RoundKind::Mission, 1, asks);
    RoundLine {
        id: s(id),
        title: s(title),
        line: format!("{} answers, submitted", round.asks.len()),
        state: RoundState::Submitted,
        answers: round.answers(),
    }
}

fn s(text: &str) -> String {
    text.into()
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|t| (*t).into()).collect()
}

/// The setup every mock world shows on New.
pub fn setup() -> Setup {
    Setup {
        project: s("pilot"),
        model: s("Default model"),
        access: s("Build: edits files in its own workspace"),
        digest: s("setup-1"),
    }
}

/// The world for `scenario`.
pub fn world(scenario: PlanScenario) -> PlanWorld {
    let mut world = PlanWorld {
        availability: PlanAvailability::Mock,
        reason: String::new(),
        setup: setup(),
        plans: Vec::new(),
    };
    match scenario {
        PlanScenario::Fresh => {}
        PlanScenario::Interview => world.plans.push(export(false)),
        PlanScenario::Wayfinder => {
            world.plans.push(export(false));
            world.plans.push(linux(true));
        }
        PlanScenario::Review => world.plans.push(export_review()),
        PlanScenario::Trouble => {
            world.plans.push(search_review());
            world.plans.push(linux(false));
            world.plans.push(export(true));
        }
        PlanScenario::Unavailable => {
            world.availability = PlanAvailability::Unavailable;
            world.reason = s("Planning is not connected in this build.");
        }
        PlanScenario::Held => {
            let mut plan = export(false);
            plan.continuation = false;
            world.plans.push(plan);
        }
        PlanScenario::Long => world.plans.push(long()),
        PlanScenario::Revisit => world.plans.push(revisit::notify("notify", PauseNeed::None)),
        PlanScenario::RevisitTrouble => {
            // Someone changes the mission while the user confirms.
            let mut changes =
                revisit::notify_review("notify", "Quieter notifications", PauseNeed::None);
            if let Some(r) = changes.revisit.as_mut() {
                r.ack = revisit::ConfirmAck::Change;
            }
            world.plans.push(changes);
            // Chats still work on it: a confirmation is refused.
            world.plans.push(revisit::notify_review(
                "digest",
                "Weekly digest",
                PauseNeed::Needed,
            ));
            // Paused, and the confirmation's answer is lost.
            let mut lost = revisit::notify_review("alerts", "Calmer alerts", PauseNeed::Paused);
            if let Some(r) = lost.revisit.as_mut() {
                r.ack = revisit::ConfirmAck::Lose;
            }
            world.plans.push(lost);
        }
    }
    world
}

/// A mission interview at the size limit of one round: 40 questions,
/// eight per section, a few answered.
fn long() -> Plan {
    let mut plan = Plan::new(
        "long",
        "Rework the settings window",
        "Rework the settings window so people find things.",
        PlanRoute::Interview,
        "Every setting is easy to find, and nothing people rely on moves without a note.",
    );
    let sections = [
        S::Outcome,
        S::NonGoals,
        S::Constraints,
        S::Acceptance,
        S::Authority,
    ];
    let mut asks = Vec::new();
    for n in 1..=40 {
        let section = sections[(n - 1) / 8];
        let ask = Ask::new(
            &format!("q{n}"),
            section,
            &format!("Question {n}: which way should setting group {n} go?"),
            &[
                ("keep", "Keep it where it is", n % 3 == 0),
                ("move", "Move it to its own page", n % 3 == 1),
                ("merge", "Merge it with the group before", false),
            ],
        );
        asks.push(if n % 7 == 0 {
            ask.answer(Some("keep"), "")
        } else {
            ask
        });
    }
    plan.round = Some(Round::new("long-1", RoundKind::Mission, 1, asks));
    plan
}

/// The first round of a new mission, from a goal the user just wrote.
pub(crate) fn first_round(mission_id: &str) -> Round {
    Round::new(
        &format!("{mission_id}-1"),
        RoundKind::Mission,
        1,
        vec![
            Ask::new(
                "n1",
                S::Outcome,
                "What would make this worth doing?",
                &[
                    ("a", "It saves you time every week", true),
                    ("b", "It unblocks other work", false),
                    ("c", "Someone asked for it", false),
                ],
            ),
            Ask::new(
                "n2",
                S::NonGoals,
                "What should Pilot leave out for now?",
                &[
                    ("a", "Anything beyond a first working version", true),
                    ("b", "Nothing. Do it fully", false),
                ],
            ),
            Ask::new(
                "n3",
                S::Constraints,
                "What must not change?",
                &[
                    ("a", "Existing behavior and saved data", true),
                    ("b", "Nothing in particular", false),
                ],
            ),
            Ask::new(
                "n4",
                S::Acceptance,
                "How will you check that it is done?",
                &[
                    ("a", "A short demo you can try yourself", true),
                    ("b", "Passing checks are enough", false),
                ],
            ),
            Ask::new(
                "n5",
                S::Authority,
                "May Pilot open a pull request when it is done?",
                &[
                    ("a", "Yes, and wait for my review", true),
                    ("b", "No, keep it local until I say", false),
                ],
            ),
        ],
    )
}

fn export_asks() -> Vec<Ask> {
    vec![
        Ask::new(
            "who",
            S::Outcome,
            "Who is the export for?",
            &[
                ("you", "You, to keep a record", true),
                ("team", "Teammates who do not use Pilot", false),
                ("both", "Both", false),
            ],
        ),
        Ask::new(
            "what",
            S::Outcome,
            "What should one export include?",
            &[
                ("messages", "Messages only", false),
                ("tools", "Messages and tool results", true),
                ("all", "Messages, tool results and artifacts", false),
            ],
        ),
        Ask::new(
            "formats",
            S::NonGoals,
            "Should other formats wait?",
            &[
                ("markdown", "Yes, Markdown only for now", true),
                ("html", "No, add HTML too", false),
            ],
        ),
        Ask::new(
            "where",
            S::Constraints,
            "Where may Pilot write the file?",
            &[
                ("panel", "Ask every time, with a save panel", true),
                ("downloads", "Always the Downloads folder", false),
            ],
        ),
        Ask::new(
            "size",
            S::Constraints,
            "How large can one export be?",
            &[
                ("warn", "No limit; warn above 10 MB", true),
                ("stop", "Stop at 10 MB", false),
            ],
        ),
        Ask::new(
            "check",
            S::Acceptance,
            "How will you know it works?",
            &[
                (
                    "fast",
                    "A 2,000-message chat exports in under 2 seconds",
                    true,
                ),
                ("errors", "Any chat exports without errors", false),
            ],
        ),
        Ask::new(
            "pr",
            S::Authority,
            "May Pilot open a pull request when it is done?",
            &[
                ("yes", "Yes, open it and wait for my review", true),
                ("no", "No, keep it local until I say", false),
            ],
        ),
    ]
}

fn export_plan() -> Plan {
    let mut plan = Plan::new(
        "export",
        "Export a chat as Markdown",
        "Let people export a chat as a Markdown file they can keep or share.",
        PlanRoute::Interview,
        "Any chat can leave Pilot as one readable Markdown file.",
    );
    plan.script = Script::Export;
    plan
}

/// The export mission's first round: three of seven answered. In trouble,
/// every question has an answer, but two no longer count, and the
/// submission's answer is lost.
fn export(trouble: bool) -> Plan {
    let mut plan = export_plan();
    let mut asks = export_asks();
    if trouble {
        let answers: [(&str, Option<&str>, &str); 7] = [
            ("who", Some("both"), ""),
            ("what", Some("tools"), ""),
            ("formats", Some("markdown"), ""),
            ("where", Some("downloads"), ""),
            ("size", Some("warn"), ""),
            ("check", Some("errors"), "Including chats with images."),
            ("pr", Some("yes"), ""),
        ];
        asks = asks
            .into_iter()
            .zip(answers)
            .map(|(ask, (_, choice, text))| ask.answer(choice, text))
            .collect();
        // Pilot asked again after the user answered: the question's words
        // changed, and one suggestion was withdrawn.
        asks[3].prompt =
            s("Where may Pilot write the file? It cannot write outside folders you pick.");
        asks[3].choices.retain(|c| c.id != "downloads");
        asks[3].choices.push(crate::plan::Choice {
            id: s("last"),
            meaning: s("The folder you picked last time"),
            recommended: false,
        });
        asks[5].choices.retain(|c| c.id != "errors");
    } else {
        asks[0] = asks[0].clone().answer(Some("you"), "");
        asks[2] = asks[2]
            .clone()
            .answer(Some("markdown"), "HTML can come later if someone asks.");
        asks[4] = asks[4].clone().answer(None, "Warn above 5 MB; never stop.");
    }
    let mut round = Round::new("export-1", RoundKind::Mission, 1, asks);
    if trouble {
        round.ack = SubmitAck::Lose;
        round.revision = 9;
    } else {
        round.revision = 4;
    }
    plan.round = Some(round);
    plan
}

/// The questions only tool results raise. They depend on an answer.
/// The second round: new questions only, raised by round 1's answers. It
/// never repeats a round 1 question. When an earlier answer leaves a gap, a
/// newly framed follow-up names the answer and the gap.
fn export_round_two(shared: bool) -> Round {
    let mut asks = vec![
        Ask::new(
            "secrets",
            S::Constraints,
            "Tool results can hold secrets. What should an export do with them?",
            &[
                ("omit", "Leave out tool output; keep the call names", true),
                ("redact", "Redact known secrets and keep the rest", false),
            ],
        ),
        Ask::new(
            "long",
            S::Acceptance,
            "Some tool results are very long. How should they show?",
            &[
                ("fold", "Folded under a one-line summary", true),
                ("full", "In full", false),
            ],
        ),
    ];
    if shared {
        asks.push(Ask::new(
            "links",
            S::Constraints,
            "In round 1 you said exports are also for teammates who do not use Pilot. They cannot open links to Pilot chats. What should an export do with those links?",
            &[
                ("text", "Keep them as plain text", false),
                ("drop", "Leave them out", true),
            ],
        ));
    }
    for ask in &mut asks {
        ask.new = true;
    }
    Round::new("export-2", RoundKind::Mission, 2, asks)
}

fn export_spec(extra: Option<&str>) -> Spec {
    let mut implementation = strings(&[
        "An Export command in the chat menu",
        "A streaming Markdown writer in the daemon that leaves tool output out",
        "A save panel in the app; nothing is written without it",
    ]);
    if let Some(extra) = extra {
        implementation.push(format!("Changed after your review: {extra}"));
    }
    Spec {
        problem: s("Chats cannot leave Pilot. People copy messages by hand and lose tool results."),
        solution: s("An Export command writes one chat as a Markdown file, through a save panel."),
        stories: vec![
            Story {
                id: s("s1"),
                text: s("As a user, I export a chat to keep a record of it."),
            },
            Story {
                id: s("s2"),
                text: s("As a user, I share an export with a teammate who does not use Pilot."),
            },
        ],
        implementation,
        testing: strings(&[
            "Writer tests: a 2,000-message chat exports in under 2 seconds",
            "Tests that tool output and secrets never reach the file",
            "A headless test of the menu command and a cancelled save panel",
        ]),
        exclusions: strings(&["HTML and PDF export", "Exporting several chats at once"]),
    }
}

fn export_slices() -> Vec<Slice> {
    vec![
        Slice {
            id: s("writer"),
            title: s("Markdown writer"),
            outcome: s("A chat becomes one Markdown file, without tool output."),
            acceptance: strings(&[
                "A 2,000-message chat writes in under 2 seconds",
                "Tool calls show by name; their output is left out",
            ]),
            stories: strings(&["s1"]),
            after: Vec::new(),
            owners: vec![SliceOwner::Backend],
        },
        Slice {
            id: s("command"),
            title: s("Export command and save panel"),
            outcome: s("Export in the chat menu writes the file where you choose."),
            acceptance: strings(&[
                "Cancelling the save panel writes nothing",
                "The file opens in any Markdown reader",
            ]),
            stories: strings(&["s1", "s2"]),
            after: strings(&["Markdown writer"]),
            owners: vec![SliceOwner::Ui, SliceOwner::Backend],
        },
        Slice {
            id: s("long"),
            title: s("Fold long tool results"),
            outcome: s("Long tool results show as one summary line."),
            acceptance: strings(&["A result over 40 lines shows as one line with its length"]),
            stories: strings(&["s2"]),
            after: strings(&["Markdown writer"]),
            owners: vec![SliceOwner::Backend],
        },
    ]
}

fn proposal(spec: Spec, slices: Vec<Slice>, open_fog: Vec<String>) -> Proposal {
    let digest = digest(&format!("{spec:?}{slices:?}{open_fog:?}"));
    Proposal {
        digest,
        spec,
        slices,
        open_fog,
    }
}

/// The one question of a review: approve publication, or ask for changes.
fn review_round(id: &str, round: u32, proposal: &Proposal) -> Round {
    let mut round = Round::new(
        id,
        RoundKind::Review,
        round,
        vec![Ask::new(
            "review",
            S::Authority,
            "Should Pilot publish this plan as tasks?",
            &[
                (
                    "approve",
                    "Yes. Publish it as tasks; start nothing yet",
                    false,
                ),
                ("revise", "Not yet. Change it first (say what below)", false),
            ],
        )],
    );
    round.proposal = proposal.digest.clone();
    round
}

fn export_review() -> Plan {
    let mut plan = export_plan();
    plan.rounds = vec![
        submitted_round(
            "export-1",
            "Round 1",
            export_asks(),
            &[
                ("who", Some("both"), ""),
                ("what", Some("tools"), ""),
                ("formats", Some("markdown"), ""),
                ("where", Some("panel"), ""),
                ("size", Some("warn"), ""),
                ("check", Some("fast"), ""),
                ("pr", Some("yes"), "Mark it as a draft first."),
            ],
        ),
        submitted_round(
            "export-2",
            "Round 2",
            export_round_two(false).asks,
            &[("secrets", Some("omit"), ""), ("long", Some("fold"), "")],
        ),
    ];
    plan.submitted = StepState::Done;
    plan.continued = StepState::Done;
    let proposal = proposal(
        export_spec(None),
        export_slices(),
        strings(&["How exports should look on phones. Not explored yet."]),
    );
    plan.round = Some(review_round("export-review-3", 3, &proposal));
    plan.proposal = Some(proposal);
    plan.next_round = 4;
    plan
}

/// A plan in review that the mock coordinator changes on the user's first
/// save: the review closes and a new one opens.
fn search_review() -> Plan {
    let mut plan = export_review();
    plan.mission_id = s("search");
    plan.title = s("Faster search");
    plan.goal = s("Make search fast in large workspaces.");
    plan.destination = s("Search answers in under 200 ms in a workspace of 50,000 files.");
    let proposal = proposal(
        Spec {
            problem: s("Search takes seconds in large workspaces."),
            solution: s("Keep an index per workspace and search it first."),
            stories: vec![Story {
                id: s("s1"),
                text: s("As a user, I find a file in a large workspace at once."),
            }],
            implementation: strings(&["An index kept up to date by file events"]),
            testing: strings(&["A 50,000-file fixture answers in under 200 ms"]),
            exclusions: strings(&["Searching inside binary files"]),
        },
        vec![Slice {
            id: s("index"),
            title: s("Workspace index"),
            outcome: s("Search reads the index first."),
            acceptance: strings(&["Under 200 ms on the 50,000-file fixture"]),
            stories: strings(&["s1"]),
            after: Vec::new(),
            owners: vec![SliceOwner::Backend],
        }],
        Vec::new(),
    );
    plan.round = Some(review_round("search-review-1", 1, &proposal));
    plan.proposal = Some(proposal);
    plan.rounds.clear();
    plan.next_round = 2;
    plan.script = Script::Plan;
    plan.amend_on_review = true;
    plan
}

/// The mock coordinator changes the plan while the user reviews it: the
/// review closes, its choice does not count, and a new review opens.
pub(crate) fn amend_during_review(plan: &mut Plan) {
    let Some(mut proposal) = plan.proposal.clone() else {
        return;
    };
    proposal.spec.implementation.push(s(
        "Rebuild the index in the background after a branch switch",
    ));
    proposal.slices.push(Slice {
        id: s("rebuild"),
        title: s("Rebuild after branch switch"),
        outcome: s("Search stays right after switching branches."),
        acceptance: strings(&["Results match the new branch within 5 seconds"]),
        stories: strings(&["s1"]),
        after: strings(&["Workspace index"]),
        owners: vec![SliceOwner::Backend],
    });
    let proposal = self::proposal(proposal.spec, proposal.slices, proposal.open_fog);
    if let Some(old) = plan.round.take() {
        plan.rounds.push(RoundLine {
            id: old.id,
            title: format!("Review, round {}", old.round),
            line: s("Closed: the plan changed, so this review does not count"),
            state: RoundState::Closed,
            answers: Vec::new(),
        });
    }
    let round = plan.next_round;
    plan.next_round += 1;
    plan.round = Some(review_round(
        &format!("{}-review-{round}", plan.mission_id),
        round,
        &proposal,
    ));
    plan.proposal = Some(proposal);
    plan.note = s(
        "Pilot changed the plan while you were reviewing it. Your earlier choice does not count. Read the plan again.",
    );
}

fn item(
    id: &str,
    title: &str,
    question: &str,
    kind: ExploreKind,
    state: ExploreState,
) -> Exploration {
    Exploration {
        id: s(id),
        title: s(title),
        question: s(question),
        kind,
        state,
        ..Exploration::default()
    }
}

/// A Wayfinder map. Its topic interview is open; in trouble, the map
/// changed after the topic's questions were asked.
fn linux(current: bool) -> Plan {
    let mut plan = Plan::new(
        "linux",
        "Pilot on Linux desktops",
        "Make Pilot work on Linux desktops.",
        PlanRoute::Wayfinder,
        "Pilot runs on Linux with the same Today and planning as on macOS.",
    );
    plan.script = Script::LinuxTopic;
    plan.submitted = StepState::Done;
    plan.continued = StepState::Done;
    plan.rounds = vec![submitted_round(
        "linux-1",
        "Round 1",
        first_round("linux").asks,
        &[
            ("n1", Some("b"), ""),
            ("n2", Some("a"), ""),
            ("n3", Some("a"), ""),
            ("n4", Some("a"), "Try it on my own laptop."),
            ("n5", Some("a"), ""),
        ],
    )];
    let mut desktops = item(
        "desktops",
        "Which desktops count",
        "Which Linux desktops must Day support first?",
        ExploreKind::Grilling,
        ExploreState::Asking,
    );
    desktops.sources = strings(&["Brief, revision 1"]);
    let mut updates = item(
        "updates",
        "How updates arrive",
        "How should Linux users get updates?",
        ExploreKind::Grilling,
        ExploreState::Waiting,
    );
    updates.after = strings(&["Packaging formats"]);
    let mut wayland = item(
        "wayland",
        "Wayland or X11",
        "Must Day run on X11 too?",
        ExploreKind::Grilling,
        ExploreState::Resolved,
    );
    wayland.result = s("Settled by Decision 4. It changed since.");
    wayland.sources = strings(&["Decision 4 (changed since)"]);
    wayland.source_refs = vec![crate::plan::MapSource {
        kind: s("decision"),
        id: s("d4"),
        label: s("Decision 4 (changed since)"),
    }];
    wayland.changed = strings(&["Decision 4 changed after Pilot cited it."]);
    let mut scope = item(
        "scope",
        "A port, not a new app",
        "Is Linux the same app on a new platform, or a separate app?",
        ExploreKind::Grilling,
        ExploreState::Resolved,
    );
    scope.result = s("Answered in interview round 1");
    scope.round = s("linux-1");
    let mut tray = item(
        "tray",
        "Status without a tray",
        "Can Day show its status on GNOME without a tray icon?",
        ExploreKind::Research,
        ExploreState::Running,
    );
    tray.by = s("A research chat, started 12 min ago");
    let packaging = item(
        "packaging",
        "Packaging formats",
        "Which Linux packages can NSH 0.4 build?",
        ExploreKind::Research,
        ExploreState::Ready,
    );
    let mut keyring = item(
        "keyring",
        "Keyring access",
        "Can Day read the daemon's token from the desktop keyring?",
        ExploreKind::Research,
        ExploreState::Resolved,
    );
    keyring.sources = strings(&["Knowledge: Linux keyring access, revision 3"]);
    keyring.source_refs = vec![crate::plan::MapSource {
        kind: s("knowledge"),
        id: s("keyring"),
        label: s("Knowledge: Linux keyring access, revision 3"),
    }];
    keyring.from_fog = s("Where credentials live");
    keyring.result =
        s("Answered by Knowledge: Linux keyring access, revision 3. Not checked by Pilot.");
    let mut status = item(
        "status-line",
        "A status line instead of a tray",
        "Is a status line in the window enough when there is no tray?",
        ExploreKind::Prototype,
        ExploreState::Ready,
    );
    status.evidence = s("Finding: supported. It matches this map.");
    status.observations = strings(&[
        "In two of three mock layouts the status stayed readable after the window lost focus.",
    ]);
    status.unresolved =
        strings(&["Is a status line enough for you, or do you also want a notification?"]);
    status.after = Vec::new();
    plan.explorations = vec![
        desktops, updates, wayland, scope, tray, packaging, keyring, status,
    ];
    plan.map = Some(MapInfo {
        revision: 6,
        agreement: String::new(),
        tasks: Vec::new(),
    });
    plan.fog = vec![
        FogArea {
            id: s("a11y"),
            area: s("Accessibility on Linux"),
            why: s("Screen reader support differs between desktops."),
            ready_when: s("Once the desktops are chosen."),
            after: strings(&["Which desktops count"]),
            sources: strings(&["Brief, revision 1"]),
            source_refs: Vec::new(),
            active: true,
            became: Vec::new(),
        },
        FogArea {
            id: s("offline"),
            area: s("Installing without a network"),
            why: s("Some people install on machines with no network access."),
            ready_when: s("Once the packaging formats are known."),
            after: strings(&["Packaging formats"]),
            sources: strings(&["Round 1, question 4"]),
            source_refs: Vec::new(),
            active: true,
            became: Vec::new(),
        },
        FogArea {
            id: s("credentials"),
            area: s("Where credentials live"),
            why: s("Day must reach the daemon without copying its token."),
            ready_when: s("Ready: it became a research question."),
            after: Vec::new(),
            sources: strings(&["Brief, revision 1"]),
            source_refs: Vec::new(),
            active: false,
            became: strings(&["Keyring access"]),
        },
    ];
    let asks = vec![
        Ask::new(
            "first",
            S::Outcome,
            "Which desktops must work on the first day?",
            &[
                ("gnome-kde", "GNOME and KDE", true),
                ("gnome", "GNOME only", false),
                ("any", "Any Wayland desktop", false),
            ],
        ),
        Ask::new(
            "working",
            S::Acceptance,
            "What counts as working?",
            &[
                ("core", "Today, New and chats work; no tray icon", true),
                ("all", "Everything the Mac app has", false),
            ],
        ),
        Ask::new(
            "packages",
            S::Constraints,
            "May Pilot use packages made for one distribution?",
            &[
                ("portable", "No. One portable package", true),
                ("each", "Yes, one per distribution", false),
            ],
        ),
    ];
    let mut round = Round::new("linux-desktops-2", RoundKind::Topic, 2, asks);
    round.topic = s("Which desktops count");
    round.topic_item = s("desktops");
    round.current = current;
    if !current {
        plan.note = s(
            "The map changed after these questions were asked. Your answers are kept; Pilot will ask again with the new map.",
        );
    }
    plan.round = Some(round);
    plan.next_round = 3;
    plan
}

/// The mock coordinator's step after a confirmed submission of `round`.
pub(crate) fn advance(plan: &mut Plan, round: Round) {
    match (plan.script, round.kind) {
        (_, RoundKind::Review) => {
            if round.chosen("review").as_deref() == Some("approve") {
                let tasks = plan.proposal.as_ref().map_or(0, |p| p.slices.len());
                plan.published = StepState::Done;
                plan.published_line = format!("Published as {tasks} tasks. No work started.");
            } else {
                let text = round.text("review");
                let wanted = if text.is_empty() {
                    None
                } else {
                    Some(text.as_str())
                };
                let changed = proposal(
                    export_spec(wanted),
                    export_slices(),
                    plan.proposal
                        .as_ref()
                        .map(|p| p.open_fog.clone())
                        .unwrap_or_default(),
                );
                let next = plan.next_round;
                plan.next_round += 1;
                plan.round = Some(review_round(
                    &format!("{}-review-{next}", plan.mission_id),
                    next,
                    &changed,
                ));
                plan.proposal = Some(changed);
                plan.note = s("Pilot changed the plan after your review. Read it again.");
            }
        }
        (Script::Export, RoundKind::Mission) if round.round == 1 => {
            let tools = matches!(round.chosen("what").as_deref(), Some("tools" | "all"));
            if tools {
                let shared = matches!(round.chosen("who").as_deref(), Some("team" | "both"));
                let next = export_round_two(shared);
                plan.note = if shared {
                    s(
                        "Your answers raised three new questions, one about a gap in an earlier answer.",
                    )
                } else {
                    s("Your answer about tool results raised two more questions.")
                };
                plan.round = Some(next);
                plan.next_round = 3;
            } else {
                review_for_export(plan);
            }
        }
        (Script::Export, RoundKind::Mission) => review_for_export(plan),
        (Script::LinuxTopic, RoundKind::Topic) => {
            if let Some(item) = plan
                .explorations
                .iter_mut()
                .find(|e| e.id == round.topic_item)
            {
                item.state = ExploreState::Resolved;
                item.result = format!("Answered in interview round {}", round.round);
                item.round = round.id.clone();
            }
            if let Some(map) = plan.map.as_mut() {
                map.revision += 1;
            }
            if let Some(fog) = plan.fog.iter_mut().find(|f| f.id == "a11y") {
                fog.ready_when = s("Ready to explore: the desktops are chosen.");
                fog.after.clear();
            }
        }
        _ => {
            plan.note = s("Pilot is writing the plan from your answers.");
        }
    }
}

fn review_for_export(plan: &mut Plan) {
    let proposal = proposal(
        export_spec(None),
        export_slices(),
        strings(&["How exports should look on phones. Not explored yet."]),
    );
    let round = plan.next_round;
    plan.next_round += 1;
    plan.round = Some(review_round(
        &format!("export-review-{round}"),
        round,
        &proposal,
    ));
    plan.proposal = Some(proposal);
    plan.note = s("The plan is ready. Read it in full before you answer.");
}
