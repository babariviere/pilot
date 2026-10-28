use super::*;
use crate::local_model::chat;
use serde_json::{Value, json};

fn c(v: Value) -> Chat {
    chat(&v).unwrap()
}
fn ids(chats: &[Chat]) -> Vec<&str> {
    chats.iter().map(|c| c.id.as_str()).collect()
}
fn sorted(mut chats: Vec<Chat>) -> Vec<Chat> {
    sort(&mut chats);
    chats
}

#[test]
fn list_order_matches_swift_list_precedes() {
    let chats = vec![
        c(json!({"id":"old","state":"idle","createdAt":1,"updatedAt":10})),
        c(
            json!({"id":"merged","state":"idle","createdAt":1,"updatedAt":900,
            "pullRequest":{"state":"merged","number":1,"url":"https://github.com/o/r/pull/1"}}),
        ),
        c(json!({"id":"pinned","state":"idle","pinned":true,"createdAt":1,"updatedAt":1})),
        c(json!({"id":"new","state":"idle","createdAt":1,"updatedAt":50})),
        // Equal activity: newer createdAt first, then ascending id.
        c(json!({"id":"tie-b","state":"idle","createdAt":5,"updatedAt":20})),
        c(json!({"id":"tie-a","state":"idle","createdAt":5,"updatedAt":20})),
        c(json!({"id":"tie-newer","state":"idle","createdAt":6,"updatedAt":20})),
        // Missing timestamps read as 0: oldest, still deterministic.
        c(json!({"id":"missing-b","state":"idle"})),
        c(json!({"id":"missing-a","state":"idle"})),
    ];
    let want = [
        "pinned",
        "new",
        "tie-newer",
        "tie-a",
        "tie-b",
        "old",
        "missing-a",
        "missing-b",
        "merged",
    ];
    assert_eq!(ids(&sorted(chats.clone())), want);
    // Deterministic regardless of input order.
    let mut reversed = chats;
    reversed.reverse();
    assert_eq!(ids(&sorted(reversed)), want);
}

#[test]
fn activity_uses_stable_user_and_finish_times_unless_working() {
    // A settled chat keeps its place when metadata bumps updatedAt.
    let settled = c(
        json!({"id":"a","state":"idle","createdAt":1,"updatedAt":999,
        "lastUserMessageAt":40,"outcome":"done","outcomeAt":60}),
    );
    assert_eq!(settled.order.activity, Stamp(60.));
    let replied = c(
        json!({"id":"a","state":"idle","createdAt":1,"updatedAt":999,
        "lastUserMessageAt":80,"outcome":"done","outcomeAt":60}),
    );
    assert_eq!(replied.order.activity, Stamp(80.));
    // Working chats follow live updates, including background jobs.
    let working = c(
        json!({"id":"a","state":"working","createdAt":1,"updatedAt":999,
        "lastUserMessageAt":80,"outcome":"done","outcomeAt":60}),
    );
    assert_eq!(working.order.activity, Stamp(999.));
    let jobs = c(
        json!({"id":"a","state":"idle","runningJobs":[{"id":"j"}],"createdAt":1,
        "updatedAt":500,"outcome":"done","outcomeAt":60}),
    );
    assert_eq!(jobs.order.activity, Stamp(500.));
    // A paused result is not visible, so it does not count as finish time.
    let paused = c(
        json!({"id":"a","state":"idle","sleepPaused":true,"createdAt":1,
        "updatedAt":70,"outcome":"done","outcomeAt":60}),
    );
    assert_eq!(paused.order.activity, Stamp(70.));
    // No user or finish time: updatedAt, else createdAt.
    let fresh = c(json!({"id":"a","state":"idle","createdAt":3}));
    assert_eq!(fresh.order.activity, Stamp(3.));
    let invalid = c(json!({"id":"a","state":"idle","createdAt":3,"updatedAt":"soon"}));
    assert_eq!(invalid.order.activity, Stamp(3.));
}

#[test]
fn settled_pull_requests_follow_swift_terminal_rule() {
    let pr = |state: &str| json!({"state":state,"number":1,"url":"https://github.com/o/r/pull/1"});
    assert!(
        c(json!({"id":"a","pullRequest":pr("closed")}))
            .order
            .settled
    );
    // Any open linked PR, unpublished work or active coordination keeps it unsettled.
    assert!(
        !c(json!({"id":"a","pullRequest":pr("merged"),"pullRequests":[pr("merged"),pr("open")]}))
            .order
            .settled
    );
    assert!(
        !c(json!({"id":"a","pullRequest":pr("merged"),"unpublishedWork":true}))
            .order
            .settled
    );
    assert!(
        !c(json!({"id":"a","pullRequest":pr("merged"),"activeMissionCoordinator":true}))
            .order
            .settled
    );
    assert!(!c(json!({"id":"a","pullRequest":pr("draft")})).order.settled);
    assert!(!c(json!({"id":"a"})).order.settled);
}

#[test]
fn groups_match_swift_sidebar_urgency() {
    let pr = json!({"state":"open","number":2,"url":"https://github.com/o/r/pull/2","readiness":{"state":"ready"}});
    let mut chats = sorted(vec![
        c(json!({"id":"recent","state":"idle","outcome":"done","outcomeAt":90})),
        c(json!({"id":"question","state":"idle","outcome":"question","outcomeAt":80})),
        c(json!({"id":"failed","state":"idle","outcome":"failed","outcomeAt":10})),
        c(
            json!({"id":"stalled","state":"working","attentionReason":{"kind":"tool_stall"},"updatedAt":95}),
        ),
        c(json!({"id":"working","state":"working","updatedAt":70})),
        c(json!({"id":"ready","state":"idle","pullRequest":pr,"outcome":"done","outcomeAt":60})),
        c(json!({"id":"pinned-working","state":"working","pinned":true,"updatedAt":1})),
        c(json!({"id":"archived-old","state":"idle","archivedAt":5,"updatedAt":99})),
        c(json!({"id":"archived-new","state":"idle","archivedAt":9,"updatedAt":1})),
    ]);
    let mut draft = c(json!({"id":"draft"}));
    draft.local_draft = true;
    chats.insert(0, draft);
    let groups = sections(&chats, |_| true);
    let names = |section: Section| -> Vec<&str> {
        groups[section as usize]
            .iter()
            .map(|ix| chats[*ix].id.as_str())
            .collect()
    };
    assert_eq!(names(Section::Drafts), ["draft"]);
    assert_eq!(names(Section::Pinned), ["pinned-working"]);
    // Failed first, then questions, then other attention, each in list order.
    assert_eq!(names(Section::NeedsYou), ["failed", "question", "stalled"]);
    assert_eq!(names(Section::Ready), ["ready"]);
    assert_eq!(names(Section::Working), ["working"]);
    assert_eq!(names(Section::Recent), ["recent"]);
    assert_eq!(names(Section::Archived), ["archived-new", "archived-old"]);
    // Filters keep grouping and order.
    let active = sections(&chats, |c| !c.archived && !c.local_draft);
    assert!(active[Section::Archived as usize].is_empty());
    assert_eq!(
        active[Section::NeedsYou as usize],
        groups[Section::NeedsYou as usize]
    );
}

#[test]
fn live_updates_reorder_without_writing_timestamps() {
    let mut chats = sorted(vec![
        c(json!({"id":"a","state":"idle","outcome":"done","outcomeAt":30})),
        c(json!({"id":"b","state":"idle","outcome":"done","outcomeAt":20})),
    ]);
    // A metadata-only update (newer updatedAt) does not move a settled chat.
    upsert(
        &mut chats,
        c(json!({"id":"b","state":"idle","updatedAt":500,"outcome":"done","outcomeAt":20})),
    );
    assert_eq!(ids(&chats), ["a", "b"]);
    // A reply does.
    upsert(
        &mut chats,
        c(json!({"id":"b","state":"working","updatedAt":510,"lastUserMessageAt":505})),
    );
    assert_eq!(ids(&chats), ["b", "a"]);
    assert_eq!(chats[0].order.activity, Stamp(510.));
    // New chats join in order without evicting existing identities.
    upsert(
        &mut chats,
        c(json!({"id":"c","state":"idle","createdAt":25})),
    );
    assert_eq!(ids(&chats), ["b", "a", "c"]);
    upsert(
        &mut chats,
        c(json!({"id":"d","state":"idle","createdAt":999})),
    );
    assert_eq!(ids(&chats), ["d", "b", "a", "c"]);
}

#[test]
fn recent_orders_by_activity_and_keeps_list_order_for_ties() {
    let mut chats = vec![
        c(json!({"id":"pinned","pinned":true,"state":"idle","updatedAt":1})),
        c(json!({"id":"b","state":"idle","updatedAt":5})),
        c(json!({"id":"a","state":"idle","updatedAt":5})),
    ];
    chats.sort_by(recent);
    assert_eq!(ids(&chats), ["b", "a", "pinned"]);
}

#[test]
fn row_state_never_repeats_its_section_heading() {
    let state = |v: Value| {
        let chat = c(v);
        row_state(&chat, Section::of(&chat))
    };
    let s = |a: &str, b: &str| (a.to_owned(), b.to_owned());
    assert_eq!(state(json!({"id":"w","state":"working"})), s("", "Working"));
    assert_eq!(state(json!({"id":"q","state":"idle"})), s("", ""));
    assert_eq!(
        state(json!({"id":"a","state":"idle","archivedAt":1})),
        s("", "Archived")
    );
    // Specific reasons stay visible, including under Needs you.
    let (shown, full) = state(json!({"id":"f","state":"failed"}));
    assert!(!shown.is_empty() && shown == full && shown != "Needs you");
    let (shown, _) =
        state(json!({"id":"s","state":"working","attentionReason":{"kind":"tool_stall"}}));
    assert!(!shown.is_empty() && shown != "Working");
    // Outside its own section, a state still shows (pinned working chat).
    assert_eq!(
        state(json!({"id":"p","state":"working","pinned":true})),
        s("Working", "Working")
    );
}
