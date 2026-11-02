use super::*;
use crate::local_model::ProjectPolicy;

fn project(id: &str, name: &str) -> Project {
    Project {
        id: id.into(),
        name: name.into(),
        path: "/synthetic/shared".into(),
        policy: ProjectPolicy::default(),
    }
}
fn with(p: &Project, f: impl FnOnce(&mut Project)) -> Project {
    let mut p = p.clone();
    f(&mut p);
    p
}

#[test]
fn patch_sends_only_changed_fields_with_daemon_spelling() {
    let atlas = project("a", "Atlas");
    let mut editor = Editor::new(&atlas);
    assert!(
        !editor.dirty() && editor.begin_save().is_none(),
        "clean forms never save"
    );
    editor.set_isolated(false);
    let s = editor.begin_save().unwrap();
    assert_eq!(s.patch(), json!({"workspace":"direct"}));

    let mut editor = Editor::new(&atlas);
    editor.set_name("  Atlas 日本語 👩‍💻  ");
    editor.set_require_pull_request(false);
    let s = editor.begin_save().unwrap();
    assert_eq!(
        s.patch(),
        json!({"name":"Atlas 日本語 👩‍💻","requirePullRequest":false})
    );
    let direct = with(&atlas, |p| p.policy.isolated = false);
    let mut editor = Editor::new(&direct);
    editor.set_isolated(true);
    assert_eq!(
        editor.begin_save().unwrap().patch(),
        json!({"workspace":"clone"})
    );
}

#[test]
fn whitespace_only_and_invalid_names_do_not_save() {
    let mut editor = Editor::new(&project("a", "Atlas"));
    editor.set_name(" Atlas ");
    assert!(!editor.dirty());
    editor.set_name("   ");
    assert!(editor.dirty());
    assert_eq!(name_problem(&editor.draft().name), Some("Enter a name."));
    assert!(editor.begin_save().is_none());
    editor.set_name(&"é".repeat(NAME_BYTES));
    assert!(name_problem(&editor.draft().name).is_some());
    assert!(editor.begin_save().is_none());
}

#[test]
fn revert_restores_the_newest_daemon_value() {
    let atlas = project("a", "Atlas");
    let mut editor = Editor::new(&atlas);
    editor.set_name("Draft");
    editor.catalog(&[with(&atlas, |p| p.name = "Renamed".into())]);
    assert!(editor.updated_elsewhere() && editor.dirty());
    assert_eq!(
        editor.draft().name,
        "Draft",
        "unsaved edits survive incoming changes"
    );
    assert!(editor.revert());
    assert_eq!(editor.draft().name, "Renamed");
    assert!(!editor.dirty() && !editor.updated_elsewhere());
}

#[test]
fn clean_form_follows_catalog_and_matching_value_settles_draft() {
    let atlas = project("a", "Atlas");
    let mut editor = Editor::new(&atlas);
    editor.catalog(&[with(&atlas, |p| p.policy.require_pull_request = false)]);
    assert!(!editor.draft().require_pull_request && !editor.dirty());
    editor.set_name("Boreal");
    editor.catalog(&[with(&atlas, |p| {
        p.name = "Boreal".into();
        p.policy.require_pull_request = false;
    })]);
    assert!(!editor.dirty() && !editor.updated_elsewhere());
}

#[test]
fn removed_project_is_never_retargeted_and_keeps_the_draft() {
    let atlas = project("a", "Atlas");
    let twin = project("b", "Atlas");
    let mut editor = Editor::new(&atlas);
    editor.set_name("Draft");
    assert!(editor.catalog(std::slice::from_ref(&twin)));
    assert!(editor.removed());
    assert_eq!(editor.project_id(), "a");
    assert_eq!(editor.draft().name, "Draft");
    assert!(editor.begin_save().is_none());
    assert!(
        !editor.set_isolated(false),
        "removed projects are read-only"
    );
    editor.catalog(&[twin, atlas.clone()]);
    assert!(!editor.removed());
    assert_eq!(editor.latest().unwrap().id, "a");
}

#[test]
fn save_ack_settles_only_its_own_submission_and_keeps_newer_edits() {
    let atlas = project("a", "Atlas");
    let mut editor = Editor::new(&atlas);
    editor.set_name("Boreal");
    let s = editor.begin_save().unwrap();
    assert!(editor.saving() && !editor.set_name("Edited while saving"));
    assert!(editor.begin_save().is_none(), "one save at a time");
    let mut stale = s.clone();
    stale.token += 1;
    let saved = with(&atlas, |p| p.name = "Boreal".into());
    assert!(!editor.finish(&stale, Outcome::Saved(saved.clone(), Value::Null)));
    assert!(editor.finish(&s, Outcome::Saved(saved.clone(), Value::Null)));
    assert!(
        !editor.finish(&s, Outcome::Saved(saved, Value::Null)),
        "duplicate replies are ignored"
    );
    assert_eq!(*editor.status(), Status::Idle);
    assert!(!editor.dirty());
    assert_eq!(editor.latest().unwrap().name, "Boreal");
}

#[test]
fn failure_and_unknown_keep_edits_and_never_resend() {
    let atlas = project("a", "Atlas");
    let mut editor = Editor::new(&atlas);
    editor.set_isolated(false);
    let s = editor.begin_save().unwrap();
    editor.finish(&s, Outcome::NotSent("refused"));
    assert_eq!(*editor.status(), Status::Failed("refused"));
    assert!(editor.dirty() && !editor.draft().isolated);
    let s = editor
        .begin_save()
        .expect("explicit retry after a definite failure");
    editor.finish(&s, Outcome::Unknown("lost"));
    assert_eq!(*editor.status(), Status::Unknown("lost"));
    assert!(editor.dirty() && editor.unsettled());
    // A later catalog with the original value does not settle or resend anything.
    editor.catalog(&[with(&atlas, |p| p.path = "/synthetic/other".into())]);
    assert_eq!(*editor.status(), Status::Unknown("lost"));
    // The daemon's own record showing the edit resolves it.
    editor.catalog(&[with(&atlas, |p| p.policy.isolated = false)]);
    assert_eq!(*editor.status(), Status::Idle);
    assert!(!editor.unsettled());
}

#[test]
fn unconfirmed_reply_values_are_unknown() {
    let atlas = project("a", "Atlas");
    let mut editor = Editor::new(&atlas);
    editor.set_require_pull_request(false);
    let s = editor.begin_save().unwrap();
    editor.finish(&s, Outcome::Saved(project("other", "Atlas"), Value::Null));
    assert!(matches!(editor.status(), Status::Unknown(_)));
    let s = editor.begin_save().unwrap();
    editor.finish(&s, Outcome::Saved(atlas.clone(), Value::Null));
    assert!(
        matches!(editor.status(), Status::Unknown(_)),
        "reply without the change"
    );
}

#[test]
fn concurrent_change_during_save_is_kept_visible() {
    let atlas = project("a", "Atlas");
    let mut editor = Editor::new(&atlas);
    editor.set_name("Mine");
    let s = editor.begin_save().unwrap();
    let theirs = with(&atlas, |p| p.name = "Theirs".into());
    editor.catalog(std::slice::from_ref(&theirs));
    editor.finish(
        &s,
        Outcome::Saved(with(&atlas, |p| p.name = "Mine".into()), Value::Null),
    );
    assert!(editor.updated_elsewhere());
    assert_eq!(editor.draft().name, "Mine");
    assert!(
        editor.dirty(),
        "the arrival becomes the baseline; nothing is overwritten"
    );
    // Our own broadcast arriving before the reply is not a conflict.
    let mut editor = Editor::new(&atlas);
    editor.set_name("Mine");
    let s = editor.begin_save().unwrap();
    let mine = with(&atlas, |p| p.name = "Mine".into());
    editor.catalog(std::slice::from_ref(&mine));
    editor.finish(&s, Outcome::Saved(mine, Value::Null));
    assert!(!editor.updated_elsewhere() && !editor.dirty());
}

#[test]
fn preflight_compares_only_changed_fields() {
    let atlas = project("a", "Atlas");
    let mut editor = Editor::new(&atlas);
    editor.set_name("Boreal");
    let s = editor.begin_save().unwrap();
    let unrelated = Fields::of(&with(&atlas, |p| p.policy.isolated = false));
    assert!(s.current(&unrelated, &Value::Null));
    let renamed = Fields::of(&with(&atlas, |p| p.name = "Elsewhere".into()));
    assert!(!s.current(&renamed, &Value::Null));
}

fn loaded(project: &Project, tracking: Value) -> Editor {
    let mut editor = Editor::new(project);
    let token = editor.begin_read().unwrap();
    assert!(editor.finish_read(token, Ok(tracking)));
    assert_eq!(*editor.slack_load(), SlackLoad::Ready);
    editor
}

#[test]
fn slack_edits_send_whole_tracking_with_linear_kept() {
    let atlas = project("a", "Atlas");
    let base = json!({"slackChannels":["C1"],"linearTeam":"T1","linearTeamName":"Platform"});
    let mut editor = loaded(&atlas, base.clone());
    assert!(!editor.add_channel("C1", Some("dup")), "already followed");
    assert!(editor.add_channel("C0123ABCD", Some("support-日本")));
    assert!(editor.set_mention_only("C0123ABCD", true));
    assert!(editor.set_groups("@oncall"));
    let key = editor.add_label().unwrap();
    assert!(editor.set_label_name(key, "Billing 💳"));
    assert!(editor.set_label_effect(key, project_slack::Effect::Close));
    assert!(editor.dirty());
    let s = editor.begin_save().unwrap();
    assert_eq!(
        s.patch(),
        json!({"tracking":{
            "linearTeam":"T1","linearTeamName":"Platform",
            "slackChannels":["C1","C0123ABCD"],
            "slackChannelNames":{"C0123ABCD":"support-日本"},
            "slackMentionOnlyChannels":["C0123ABCD"],
            "slackGroupHandles":["oncall"],
            "slackLabels":[{"name":"Billing 💳","description":"","effect":"close"}]
        }})
    );
    assert!(s.current(&Fields::of(&atlas), &base));
    let mut theirs = base.clone();
    theirs["linearTeam"] = json!("T2");
    assert!(
        !s.current(&Fields::of(&atlas), &theirs),
        "tracking is replaced whole, so any change refuses"
    );
    assert!(!editor.add_channel("C2", None), "read-only while saving");
    let saved = s.patch()["tracking"].clone();
    assert!(editor.finish(&s, Outcome::Saved(atlas.clone(), saved.clone())));
    assert_eq!(*editor.status(), Status::Idle);
    assert!(!editor.dirty());
    assert!(editor.slack_saved("C0123ABCD"));

    // A General-only save never touches tracking.
    let mut editor = loaded(&atlas, base);
    editor.set_isolated(false);
    assert_eq!(
        editor.begin_save().unwrap().patch(),
        json!({"workspace":"direct"})
    );
}

#[test]
fn slack_reads_follow_only_the_newest_and_keep_unsaved_edits() {
    let atlas = project("a", "Atlas");
    let mut editor = Editor::new(&atlas);
    assert!(!editor.slack_editable(), "nothing to edit before the read");
    let old = editor.begin_read().unwrap();
    let new = editor.begin_read().unwrap();
    assert!(!editor.finish_read(old, Ok(json!({"slackChannels":["STALE"]}))));
    assert!(editor.finish_read(new, Err("Couldn't reach Pilot.")));
    assert_eq!(
        *editor.slack_load(),
        SlackLoad::Failed("Couldn't reach Pilot.")
    );
    let t = editor.begin_read().unwrap();
    editor.finish_read(t, Ok(json!({"slackChannels":["C1"],"linearTeam":"T1"})));
    assert_eq!(editor.slack().channels[0].id, "C1");

    // Unsaved edits survive a Linear-only change and are saved on top of it.
    editor.add_channel("C2", None);
    let t = editor.begin_read().unwrap();
    editor.finish_read(t, Ok(json!({"slackChannels":["C1"],"linearTeam":"T9"})));
    assert!(editor.dirty() && !editor.slack_elsewhere());
    let s = editor.begin_save().unwrap();
    assert_eq!(s.patch()["tracking"]["linearTeam"], "T9");
    editor.finish(&s, Outcome::NotSent("refused"));

    // A Slack change elsewhere is shown, never merged into the draft.
    let t = editor.begin_read().unwrap();
    editor.finish_read(t, Ok(json!({"slackChannels":["C7"],"linearTeam":"T9"})));
    assert!(editor.slack_elsewhere());
    assert_eq!(editor.slack().channels.len(), 2);
    assert!(editor.revert());
    assert_eq!(editor.slack().channels[0].id, "C7");
    assert!(!editor.dirty() && !editor.slack_elsewhere());

    // A later failure keeps the loaded values.
    let t = editor.begin_read().unwrap();
    assert!(!editor.finish_read(t, Err("gone")));
    assert_eq!(*editor.slack_load(), SlackLoad::Ready);
}

#[test]
fn slack_unknown_settles_only_when_the_daemon_shows_the_values() {
    let atlas = project("a", "Atlas");
    let mut editor = loaded(&atlas, json!({"slackChannels":[]}));
    editor.add_channel("C1", Some("bugs"));
    let s = editor.begin_save().unwrap();
    let stale = editor.begin_read();
    assert!(stale.is_none(), "no reads while saving");
    editor.finish(&s, Outcome::Unknown("lost"));
    assert_eq!(*editor.status(), Status::Unknown("lost"));
    assert!(editor.dirty(), "edits survive");
    let s = editor.begin_save().expect("explicit Save stays available");
    editor.finish(&s, Outcome::Unknown("lost"));
    let t = editor.begin_read().unwrap();
    editor.finish_read(t, Ok(json!({"slackChannels":[]})));
    assert_eq!(*editor.status(), Status::Unknown("lost"), "not yet shown");
    let t = editor.begin_read().unwrap();
    editor.finish_read(
        t,
        Ok(json!({"slackChannels":["C1"],"slackChannelNames":{"C1":"bugs"}})),
    );
    assert_eq!(*editor.status(), Status::Idle);
    assert!(!editor.dirty());

    // A reply whose tracking lacks the change is Unknown, not Saved.
    let mut editor = loaded(&atlas, json!({"slackChannels":[]}));
    editor.add_channel("C1", None);
    let s = editor.begin_save().unwrap();
    editor.finish(
        &s,
        Outcome::Saved(atlas.clone(), json!({"slackChannels":[]})),
    );
    assert!(matches!(editor.status(), Status::Unknown(_)));
}

#[test]
fn unsupported_tracking_is_read_only_and_blank_labels_are_not_edits() {
    let atlas = project("a", "Atlas");
    let mut editor = Editor::new(&atlas);
    let t = editor.begin_read().unwrap();
    editor.finish_read(t, Ok(json!({"slackChannels":["C1"],"future":true})));
    assert_eq!(*editor.slack_load(), SlackLoad::Unsupported);
    assert!(!editor.add_channel("C2", None) && !editor.dirty());

    let mut editor = loaded(&atlas, Value::Null);
    let key = editor.add_label().unwrap();
    assert!(!editor.dirty(), "an empty row is not a change");
    editor.set_label_description(key, "orphan");
    assert!(editor.dirty() && !editor.can_save());
    editor.set_label_name(key, "Named");
    assert!(editor.can_save());
    editor.set_groups("@everyone");
    assert!(!editor.can_save() && editor.begin_save().is_none());
}
