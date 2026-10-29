use super::*;
use crate::local_model::chat;
use serde_json::{Value, json};

fn c(v: Value) -> Chat {
    chat(&v).unwrap()
}

#[test]
fn new_reply_follows_outcome_time_since_you_looked_never_updated_at() {
    let mut memory = Memory::ephemeral(100.);
    let old = c(json!({"id":"old","outcome":"done","outcomeAt":90}));
    let fresh = c(json!({"id":"fresh","outcome":"done","outcomeAt":150}));
    let touched = c(json!({"id":"touched","updatedAt":999,"lastUserMessageAt":500}));
    let stopped = c(json!({"id":"stopped","outcome":"stopped","outcomeAt":900}));
    assert!(!memory.unread(&old), "older than the memory itself");
    assert!(memory.unread(&fresh));
    assert!(
        !memory.unread(&touched),
        "metadata and user activity are not replies"
    );
    assert!(!memory.unread(&stopped), "a stop is not the agent's reply");
    memory.note_seen(&fresh);
    assert!(!memory.unread(&fresh));
    // A later reply lights it again; looking clears it.
    let again = c(json!({"id":"fresh","outcome":"question","outcomeAt":160}));
    assert!(memory.unread(&again));
    memory.note_seen(&again);
    assert!(!memory.unread(&again));
    // Working hides the outcome; nothing to show until the next result.
    assert!(!memory.unread(&c(
        json!({"id":"fresh","state":"working","outcome":"done","outcomeAt":170})
    )));
    let mut draft = c(json!({"id":"draft","outcome":"done","outcomeAt":900}));
    draft.local_draft = true;
    assert!(!memory.unread(&draft));
}

#[test]
fn order_is_seeded_once_and_moves_only_for_your_own_sends() {
    let mut memory = Memory::ephemeral(0.);
    let a = c(json!({"id":"a","createdAt":10,"lastUserMessageAt":50}));
    let b = c(json!({"id":"b","createdAt":20}));
    memory.observe(&[a.clone(), b.clone()]);
    assert_eq!((memory.key(&a), memory.key(&b)), (50., 20.));
    // An automatic notice moves lastUserMessageAt; the sidebar place holds.
    let notified = c(json!({"id":"b","createdAt":20,"lastUserMessageAt":9000}));
    memory.observe(std::slice::from_ref(&notified));
    assert_eq!(memory.key(&notified), 20.);
    // Your own send does move it.
    memory.note_sent("b", 9100.);
    assert_eq!(memory.key(&notified), 9100.);
    assert_eq!(memory.sent("b"), Some(9100.));
    memory.note_sent("b", 10.);
    assert_eq!(
        memory.sent("b"),
        Some(9100.),
        "an older clock never moves it back"
    );
}

#[test]
fn unloaded_memory_shows_no_dots_and_writes_nothing() {
    let dir = std::env::temp_dir().join(format!("pilot-sidebar-memory-{}", uuid::Uuid::new_v4()));
    let path = dir.join(FILE);
    let mut memory = Memory::at(path.clone());
    let fresh = c(json!({"id":"fresh","outcome":"done","outcomeAt":150,"lastUserMessageAt":7}));
    assert!(!memory.unread(&fresh));
    memory.observe(std::slice::from_ref(&fresh));
    memory.note_seen(&fresh);
    assert!(memory.take_save().is_none());
    assert_eq!(
        memory.key(&fresh),
        7.,
        "the daemon stamp stands in until load"
    );
    assert!(!path.exists());
}

#[test]
fn memory_round_trips_privately_and_a_bad_file_starts_fresh() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("pilot-sidebar-memory-{}", uuid::Uuid::new_v4()));
    let path = dir.join(FILE);
    assert_eq!(read(&path), None);
    let mut memory = Memory::at(path.clone());
    memory.restore(read(&path), 100.);
    let fresh = c(json!({"id":"fresh","outcome":"done","outcomeAt":150,"lastUserMessageAt":7}));
    let other = c(json!({"id":"other","outcome":"done","outcomeAt":160}));
    memory.observe(&[fresh.clone(), other.clone()]);
    memory.note_seen(&fresh);
    memory.note_sent("other", 200.);
    let (target, bytes) = memory.take_save().unwrap();
    assert!(memory.take_save().is_none(), "one write per change");
    write(&target, &bytes).unwrap();
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
        0o700
    );
    // Restart: the same dots and order come back.
    let mut reopened = Memory::at(path.clone());
    reopened.restore(read(&path), 999.);
    assert_eq!(reopened.saved(), memory.saved());
    assert!(!reopened.unread(&fresh));
    assert!(reopened.unread(&other));
    assert_eq!(reopened.key(&other), 200.);
    // A corrupt file is ignored, never trusted, and starts at its own baseline.
    std::fs::write(&path, b"{not json").unwrap();
    let mut fresh_start = Memory::at(path.clone());
    fresh_start.restore(read(&path), 1000.);
    assert!(!fresh_start.unread(&other));
    assert!(
        fresh_start.take_save().is_some(),
        "the fresh baseline is saved"
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn maps_stay_bounded_and_keep_the_newest() {
    let mut memory = Memory::ephemeral(0.);
    for i in 0..(CAP + 10) {
        memory.note_sent(&format!("chat-{i}"), i as f64);
    }
    assert_eq!(memory.saved().sent.len(), CAP);
    assert!(memory.sent("chat-0").is_none());
    assert_eq!(
        memory.sent(&format!("chat-{}", CAP + 9)),
        Some((CAP + 9) as f64)
    );
}
