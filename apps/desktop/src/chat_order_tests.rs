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
fn usage_pause_is_unfinished_even_with_a_previous_settled_pull_request() {
    let mut raw = json!({"id":"held","state":"idle","working":false,
        "pullRequest":{"state":"merged"},"outcome":"done","outcomeAt":50,
        "subscriptionPause":{"windows":[]}});
    let held = c(raw.clone());
    assert!(!held.order.settled);
    assert!(held.order.reply.is_none());
    raw["subscriptionPause"]["forced"] = json!(true);
    assert!(c(raw.clone()).order.settled);
    raw["subscriptionPause"] = serde_json::Value::Null;
    assert!(c(raw).order.settled);
}

#[test]
fn sidebar_sections_ignore_state_and_seed_stamps_never_use_updated_at() {
    let section = |v: Value| Section::of(&c(v));
    assert_eq!(section(json!({"id":"w","state":"working"})), Section::Chats);
    assert_eq!(section(json!({"id":"f","state":"failed"})), Section::Chats);
    assert_eq!(
        section(json!({"id":"p","state":"working","pinned":true})),
        Section::Pinned
    );
    assert_eq!(
        section(json!({"id":"a","archivedAt":3,"pinned":true})),
        Section::Archived
    );
    let mut draft = c(json!({"id":"d"}));
    draft.local_draft = true;
    assert_eq!(Section::of(&draft), Section::Drafts);
    // The user stamp falls back to creation, never to updatedAt.
    let chat = c(json!({"id":"u","createdAt":5,"updatedAt":900}));
    assert_eq!(chat.order.user, Stamp(5.));
    let chat = c(json!({"id":"u","createdAt":5,"updatedAt":900,"lastUserMessageAt":40}));
    assert_eq!(chat.order.user, Stamp(40.));
    // A reply is a settled done, question or failed outcome; not a stop,
    // not while working and never updatedAt.
    let reply = |v: Value| c(v).order.reply;
    assert_eq!(
        reply(json!({"id":"r","outcome":"done","outcomeAt":70,"updatedAt":99})),
        Some(Stamp(70.))
    );
    assert_eq!(
        reply(json!({"id":"r","outcome":"question","outcomeAt":71})),
        Some(Stamp(71.))
    );
    assert_eq!(
        reply(json!({"id":"r","state":"failed","outcome":"failed","outcomeAt":72})),
        Some(Stamp(72.))
    );
    assert_eq!(
        reply(json!({"id":"r","outcome":"stopped","outcomeAt":73})),
        None
    );
    assert_eq!(
        reply(json!({"id":"r","state":"working","outcome":"done","outcomeAt":74})),
        None
    );
    assert_eq!(reply(json!({"id":"r","updatedAt":75})), None);
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
fn row_state_keeps_the_complete_state_words() {
    let state = |v: Value| row_state(&c(v));
    assert_eq!(state(json!({"id":"w","state":"working"})), "Working");
    assert_eq!(state(json!({"id":"q","state":"idle"})), "");
    assert_eq!(
        state(json!({"id":"a","state":"idle","archivedAt":1})),
        "Archived"
    );
    assert!(!state(json!({"id":"f","state":"failed"})).is_empty());
    assert_eq!(
        state(json!({"id":"p","state":"working","pinned":true})),
        "Working"
    );
}
