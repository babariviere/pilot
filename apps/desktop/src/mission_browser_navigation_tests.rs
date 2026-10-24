use super::*;
use crate::interaction::WriteState;
use gpui_kit::{Bounds, TestAppContext, WindowBounds, WindowOptions, size};

#[gpui_kit::test]
fn unsaved_input_and_private_write_fault_refuse_mission_navigation_without_new_reads(
    cx: &mut TestAppContext,
) {
    let options = LocalOptions::synthetic(1);
    let root = std::env::temp_dir().join(format!("mission-nav-fault-{}", uuid::Uuid::new_v4()));
    let store = Store::open(root.clone(), options.host()).unwrap();
    let book = Arc::new(store.book.clone());
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
    let (writer, writes) = Interaction::recording();
    let (client, reads) = LocalClient::synthetic_commands();
    cx.update(|cx| {
        gpui_kit::init(cx);
        crate::init_appearance(cx);
    });
    let (h, view) = cx
        .update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(960.), px(640.)),
                    ))),
                    show: false,
                    ..Default::default()
                },
                cx,
                |w, cx| {
                    cx.new(|cx| {
                        let mut v = LocalViewer::build(Some(client), Some(writer), w, cx);
                        v.selected = Some("source".into());
                        v.editor.update(cx, |e, cx| {
                            e.accept(
                                WriteState {
                                    book: Some(book.clone()),
                                    ..Default::default()
                                },
                                w,
                                cx,
                            );
                            e.select("chat:source".into(), true, false, w, cx);
                        });
                        v
                    })
                },
            )
        })
        .unwrap();
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| {
            let input = v.editor.read(cx).shell_probe().0;
            input.update(cx, |t, cx| {
                t.set_value("x".repeat(crate::delivery_store::TEXT_CAP + 1), w, cx)
            });
            assert!(!v.show_missions(w, cx));
            assert_eq!(v.page, Page::Chat);
            assert!(v.missions.read(cx).route.is_none());
            assert_eq!(
                input.read(cx).value().len(),
                crate::delivery_store::TEXT_CAP + 1
            );
            input.update(cx, |t, cx| t.set_value("Retained draft", w, cx));
            v.editor.update(cx, |e, cx| {
                e.accept(
                    WriteState {
                        book: Some(book.clone()),
                        error: Some("Private write fault remains fenced"),
                        ..Default::default()
                    },
                    w,
                    cx,
                )
            });
            assert!(!v.show_missions(w, cx));
            assert_eq!(v.page, Page::Chat);
            assert_eq!(v.selected.as_deref(), Some("source"));
            assert!(v.missions.read(cx).route.is_none());
            assert_eq!(input.read(cx).value().as_ref(), "Retained draft");
            assert_eq!(
                v.editor.read(cx).resource_navigation_issue(),
                Some("Private write fault remains fenced")
            );
        })
    })
    .unwrap();
    assert!(reads.try_recv().is_err());
    assert!(writes.try_recv().is_err());
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
}
