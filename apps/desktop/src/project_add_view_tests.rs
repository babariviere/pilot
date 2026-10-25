use super::*;
use gpui_kit::{AppContext, Entity, TestAppContext, WindowOptions};
fn setup(
    cx: &mut TestAppContext,
) -> (
    gpui_kit::AnyWindowHandle,
    Entity<ProjectAdd>,
    async_channel::Receiver<WriteCommand>,
) {
    let (writer, commands) = Interaction::recording();
    cx.update(|cx| {
        gpui_kit::init(cx);
        crate::local_view::LocalViewer::bind_keys(cx);
    });
    let (h, f) = cx.update(|cx| {
        gpui_kit::open_window(WindowOptions::default(), cx, |w, cx| {
            cx.new(|cx| {
                let mut f = ProjectAdd::new(Some(writer), cx);
                f.accept(
                    &WriteState {
                        book: Some(Arc::new(Book::shell_probe())),
                        ..Default::default()
                    },
                    cx,
                );
                f.open(None, w, cx);
                f
            })
        })
        .unwrap()
    });
    (h, f, commands)
}
#[gpui_kit::test]
fn explicit_provider_cancel_bad_paths_late_dialog_and_double_submit(cx: &mut TestAppContext) {
    let (h, f, commands) = setup(cx);
    cx.update_window(h, |_, w, cx| {
        f.update(cx, |f, cx| {
            f.folders = Some(
                [
                    Ok(None),
                    Ok(Some(PathBuf::from("relative"))),
                    Err("Synthetic folder error"),
                    Ok(Some(PathBuf::from("/synthetic/日本語"))),
                ]
                .into(),
            );
            f.choose(w, cx);
            assert!(f.path.is_none());
            f.choose(w, cx);
            assert!(f.path.is_none());
            f.choose(w, cx);
            assert!(f.path.is_none());
            let old = f.epoch;
            f.close(cx);
            f.open(None, w, cx);
            f.chosen(old, Ok(Some(PathBuf::from("/stale"))), cx);
            assert!(f.path.is_none());
            f.choose(w, cx);
            assert_eq!(f.path.as_deref(), Some("/synthetic/日本語"));
            assert!(commands.try_recv().is_err());
            f.confirm(cx);
            f.confirm(cx);
            f.choose(w, cx);
            f.refresh(cx);
        })
    })
    .unwrap();
    let WriteCommand::Project { path, .. } = commands.try_recv().unwrap() else {
        panic!("only registration")
    };
    assert_eq!(path.as_deref(), Some("/synthetic/日本語"));
    assert!(commands.try_recv().is_err());
}
#[gpui_kit::test]
fn stale_replies_unknown_read_and_closed_private_fault_receipt_are_not_replayed(
    cx: &mut TestAppContext,
) {
    let (h, f, commands) = setup(cx);
    cx.update_window(h, |_, w, cx| {
        f.update(cx, |f, cx| {
            f.path = Some("/synthetic/folder".into());
            f.confirm(cx);
            let id = f.request.clone();
            f.close(cx);
            let mut book = Book::shell_probe();
            book.project_registrations.insert(
                id.clone(),
                crate::project_registration::Attempt {
                    id: id.clone(),
                    path: f.path.clone().unwrap(),
                    created: None,
                },
            );
            let state = WriteState {
                book: Some(Arc::new(book)),
                project: Some(crate::project_registration::Reply {
                    id: id.clone(),
                    result: Ok(Outcome::Unknown("Response lost")),
                    catalog: Some(Ok(vec![])),
                }),
                ..Default::default()
            };
            f.accept(&state, cx);
            f.open(None, w, cx);
            f.confirm(cx);
            assert!(!f.pending);
            let mut stale = state.clone();
            stale.project.as_mut().unwrap().id = "stale-request".into();
            stale.project.as_mut().unwrap().result = Ok(Outcome::Pending);
            f.accept(&stale, cx);
            assert!(!f.pending);
            let mut known = state.clone();
            known.project_receipt = Some((id.clone(), "canonical-id".into()));
            known.error = Some("Private write fault");
            f.close(cx);
            f.accept(&known, cx);
            f.open(Some("Keep unsaved input"), w, cx);
            assert_eq!(f.known(), Some("canonical-id"));
            assert!(!f.mutable());
            f.confirm(cx);
            f.choose(w, cx);
            f.refresh(cx);
        })
    })
    .unwrap();
    assert!(matches!(
        commands.try_recv(),
        Ok(WriteCommand::Project { path: Some(_), .. })
    ));
    assert!(commands.try_recv().is_err());
}
#[gpui_kit::test]
fn read_failures_never_claim_catalog_refreshed_and_preflight_errors_allow_explicit_retry(
    cx: &mut TestAppContext,
) {
    let (h, f, commands) = setup(cx);
    cx.update_window(h, |_, _, cx| {
        f.update(cx, |f, cx| {
            f.path = Some("/synthetic/folder".into());
            f.confirm(cx);
            let state = WriteState {
                book: f.book.clone(),
                project: Some(crate::project_registration::Reply {
                    id: f.request.clone(),
                    result: Err("Preflight unavailable; no POST sent"),
                    catalog: Some(Err("Catalog unavailable")),
                }),
                ..Default::default()
            };
            f.accept(&state, cx);
            assert!(!f.pending);
            assert_eq!(f.catalog_error, Some("Catalog unavailable"));
            f.confirm(cx);
            assert!(f.pending);
        })
    })
    .unwrap();
    assert!(commands.try_recv().is_ok());
    assert!(commands.try_recv().is_ok());
    assert!(commands.try_recv().is_err());
}
