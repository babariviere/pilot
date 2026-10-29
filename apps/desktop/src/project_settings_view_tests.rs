use super::*;
use crate::local_model::ProjectPolicy;
use gpui_kit::TestAppContext;

fn project(id: &str, name: &str) -> Project {
    Project {
        id: id.into(),
        name: name.into(),
        path: format!("/synthetic/{id}"),
        policy: ProjectPolicy::default(),
    }
}

#[gpui_kit::test]
fn pages_keep_exact_ids_and_drafts_across_selection_and_removal(cx: &mut TestAppContext) {
    let owner = cx.update(|cx| cx.new(|_| ProjectSettings::new(None)));
    owner.update(cx, |o, cx| {
        o.catalog(
            Arc::new(vec![project("a", "Atlas"), project("b", "Atlas")]),
            cx,
        );
        o.select("a".into(), cx);
        o.edit(|e| e.set_isolated(false), cx);
        o.select("b".into(), cx);
        assert!(!o.editor("b").unwrap().dirty());
        assert!(
            o.editor("a").unwrap().dirty(),
            "switching keeps the other draft"
        );
        assert_eq!(o.unsettled().as_deref(), Some("Atlas"));
        assert_eq!(o.update_hold(), Some(crate::update_hold::Hold::Unsaved));
        // Removing A never retargets its page to the same-named B.
        o.catalog(Arc::new(vec![project("b", "Atlas")]), cx);
        o.select("a".into(), cx);
        let a = o.editor("a").unwrap();
        assert!(a.removed() && a.project_id() == "a" && a.dirty());
        // Unknown IDs show as unavailable rather than borrowing another page.
        o.select("gone".into(), cx);
        assert!(o.editor("gone").is_none());
        assert_eq!(o.selected.as_deref(), Some("gone"));
    });
}

#[gpui_kit::test]
fn preview_owner_never_sends_and_keeps_edits(cx: &mut TestAppContext) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        crate::init_appearance(cx);
    });
    let owner = cx.update(|cx| cx.new(|_| ProjectSettings::new(None)));
    let window = cx.add_window(|_, _| gpui_kit::Empty);
    window
        .update(cx, |_, window, cx| {
            owner.update(cx, |o, cx| {
                o.catalog(Arc::new(vec![project("a", "Atlas")]), cx);
                o.select("a".into(), cx);
                o.edit(|e| e.set_require_pull_request(false), cx);
                o.save(window, cx);
                let e = o.editor("a").unwrap();
                assert!(matches!(e.status(), Status::Failed(_)));
                assert!(e.dirty() && !e.draft().require_pull_request);
                o.revert(cx);
                assert!(!o.editor("a").unwrap().dirty());
                assert_eq!(o.update_hold(), None);
            })
        })
        .unwrap();
}

#[gpui_kit::test]
fn identical_catalog_does_not_notify(cx: &mut TestAppContext) {
    let owner = cx.update(|cx| cx.new(|_| ProjectSettings::new(None)));
    let catalog = Arc::new(vec![project("a", "Atlas")]);
    let notified = std::rc::Rc::new(std::cell::Cell::new(0));
    let seen = notified.clone();
    let _watch = cx.update(|cx| cx.observe(&owner, move |_, _| seen.set(seen.get() + 1)));
    owner.update(cx, |o, cx| o.catalog(catalog.clone(), cx));
    owner.update(cx, |o, cx| o.catalog(catalog.clone(), cx));
    cx.run_until_parked();
    assert_eq!(notified.get(), 1);
}
