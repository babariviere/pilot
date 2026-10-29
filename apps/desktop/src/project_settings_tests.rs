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
    assert!(!editor.finish(&stale, Outcome::Saved(saved.clone())));
    assert!(editor.finish(&s, Outcome::Saved(saved.clone())));
    assert!(
        !editor.finish(&s, Outcome::Saved(saved)),
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
    editor.finish(&s, Outcome::Saved(project("other", "Atlas")));
    assert!(matches!(editor.status(), Status::Unknown(_)));
    let s = editor.begin_save().unwrap();
    editor.finish(&s, Outcome::Saved(atlas.clone()));
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
    editor.finish(&s, Outcome::Saved(with(&atlas, |p| p.name = "Mine".into())));
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
    editor.finish(&s, Outcome::Saved(mine));
    assert!(!editor.updated_elsewhere() && !editor.dirty());
}

#[test]
fn preflight_compares_only_changed_fields() {
    let atlas = project("a", "Atlas");
    let mut editor = Editor::new(&atlas);
    editor.set_name("Boreal");
    let s = editor.begin_save().unwrap();
    let unrelated = Fields::of(&with(&atlas, |p| p.policy.isolated = false));
    assert!(s.current(&unrelated));
    let renamed = Fields::of(&with(&atlas, |p| p.name = "Elsewhere".into()));
    assert!(!s.current(&renamed));
}
