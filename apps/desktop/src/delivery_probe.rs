//! Mounted production composer with isolated private metadata and a command recorder.
//! No Local options, worker, network, Check POST, execute, resend or real profile.
use super::*;
use crate::{
    delivery_store::{
        Delivery, Host, Store,
        diagnostic::{Acknowledgment, Category, Diagnostic, Stage},
    },
    interaction::DeliveryReport,
    ui::{self, Text},
};
use gpui_kit::{
    AnyWindowHandle, Bounds, HeadlessAppContext, WindowBounds, WindowOptions, component::ThemeMode,
    size, test::TestWindowExt,
};
use std::{sync::Arc, time::Duration};

struct Fixture {
    editor: Entity<ChatEditor>,
}
impl Render for Fixture {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .v_flex()
            .size_full()
            .min_w_0()
            .bg(cx.theme().background)
            .child(
                div()
                    .flex_1()
                    .p_4()
                    .child(ui::text(Text::Body, "Delivery recovery"))
                    .child(ui::text(
                        Text::Caption,
                        "Isolated synthetic composer. No live actions.",
                    )),
            )
            .child(self.editor.clone())
    }
}
fn frame(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    cx.advance_clock(Duration::from_millis(16));
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
}
pub fn run_delivery_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_DELIVERY_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let root =
                std::env::temp_dir().join(format!("native-delivery-{}", uuid::Uuid::new_v4()));
            let host = Host {
                host_id: "local".into(),
                daemon_id: "synthetic-daemon".into(),
                lineage_id: "synthetic-lineage".into(),
            };
            let mut store = Store::open(root.clone(), host.clone()).unwrap();
            let intent = store
                .prepare(
                    "chat:a",
                    &Draft {
                        revision: 1,
                        text: "Unsent draft 👩‍💻 日本語 e\u{301} stays with its original operation"
                            .into(),
                        ..Default::default()
                    },
                    false,
                    false,
                )
                .unwrap();
            let original = serde_json::to_vec(intent.operation.as_ref().unwrap()).unwrap();
            let mut delivery = Delivery::from_intent(&intent);
            delivery.diagnostic = Some(Diagnostic {
                stage: Stage::Lookup,
                category: Category::Refused,
                status: Some(503),
                acknowledgment: Acknowledgment::Unknown,
            });
            store.record_diagnostic("chat:a", &delivery).unwrap();
            drop(store);
            let store = Store::open(root.clone(), host).unwrap();
            let state = WriteState {
                book: Some(Arc::new(store.book.clone())),
                notice: "Draft saved.",
                ..Default::default()
            };
            let (writer, commands) = Interaction::recording();
            cx.update(|cx| {
                crate::appearance::commit_appearance(
                    if mode == ThemeMode::Dark {
                        crate::settings_state::AppearancePreference::Dark
                    } else {
                        crate::settings_state::AppearancePreference::Light
                    },
                    cx,
                )
            });
            let (h, editor) = cx.update(|cx| {
                let mut editor = None;
                let (h, _) = gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(560.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |w, cx| {
                        let view = cx.new(|cx| {
                            let mut e = ChatEditor::new(Some(writer.clone()), w, cx);
                            e.accept(state.clone(), w, cx);
                            e.select("chat:a".into(), true, false, w, cx);
                            e
                        });
                        editor = Some(view.clone());
                        cx.new(|_| Fixture { editor: view })
                    },
                )
                .unwrap();
                (h, editor.unwrap())
            });
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(cx.theme().mode, mode);
                assert!((f32::from(w.viewport_size().width) - width).abs() < 1.);
                let tray = w.find("composer-tray").bounds();
                for id in ["composer-input", "composer-controls"] {
                    let b = w.find(id).bounds();
                    assert!(
                        b.left() >= tray.left() && b.right() <= tray.right(),
                        "{id}: {b:?} outside {tray:?}"
                    );
                    assert!(b.top() >= tray.top() && b.bottom() <= tray.bottom());
                }
                assert!(w.try_find("delivery-diagnostic").is_none());
                let status = w.find("delivery-recovery-status");
                assert_eq!(
                    status.label(),
                    Some("Couldn't confirm this message was sent.")
                );
                assert!(status.bounds().bottom() < tray.top());
                assert_eq!(w.find("local-send").disabled(), Some(true));
                assert!(
                    editor
                        .read(cx)
                        .delivery_detail("chat:a", &editor.read(cx).cache["chat:a"])
                        .unwrap()
                        .1
                        .contains("HTTP 503")
                );
            })
            .unwrap();
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{}-{}-retained.png", width as u32, mode.name())))
                    .unwrap();
            }
            assert!(commands.try_recv().is_err(), "No automatic Check/execute");
            cx.update_window(h, |_, w, cx| w.click("composer-recovery", cx))
                .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("delivery-diagnostic").visible());
                w.click("check-delivery", cx);
            })
            .unwrap();
            frame(cx, h);
            assert!(
                matches!(commands.try_recv(),Ok(WriteCommand::Check {id,retry:false}) if id==intent.id)
            );
            assert!(commands.try_recv().is_err());
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| e.focus(w, cx));
                w.input(" new native e\u{301}", cx);
                w.press("enter", cx);
            })
            .unwrap();
            frame(cx, h);
            assert!(
                commands.try_recv().is_err(),
                "Pending Enter must not Submit"
            );
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| {
                    e.changed(cx);
                    assert!(e.cache["chat:a"].text.contains("new native"));
                    let mut autosave = e.state.clone();
                    autosave.notice = "Draft saved.";
                    autosave.notice_key = None;
                    e.accept(autosave, w, cx);
                    e.select("chat:other".into(), true, false, w, cx);
                    assert!(e.delivery_detail("chat:other", &Draft::default()).is_none());
                    e.select("chat:a".into(), true, false, w, cx);
                    assert!(
                        e.delivery_detail("chat:a", &e.cache["chat:a"])
                            .unwrap()
                            .1
                            .contains("HTTP 503")
                    );
                })
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                editor.update(cx, |e, cx| {
                    let mut state = e.state.clone();
                    let mut d = delivery.clone();
                    d.diagnostic = Some(Diagnostic {
                        stage: Stage::Adoption,
                        category: Category::PrivateWrite,
                        status: Some(200),
                        acknowledgment: Acknowledgment::Accepted,
                    });
                    state.delivery_reports.insert(
                        intent.id.clone(),
                        DeliveryReport {
                            key: "chat:a".into(),
                            delivery: d,
                            saved: false,
                            save_error: Some(Category::PrivateWrite),
                        },
                    );
                    state.error = Some(
                        "Private state write failed. Keep/copy unsaved text before restarting.",
                    );
                    state.notice = "Unrelated draft saved.";
                    state.notice_key = Some("chat:other".into());
                    e.accept(state, w, cx);
                    let detail = e.delivery_detail("chat:a", &e.cache["chat:a"]).unwrap().1;
                    assert!(
                        detail.contains("Local accepted")
                            && detail.contains("not durably confirmed for restart")
                    );
                    assert_eq!(
                        e.state.book.as_ref().unwrap().pending[&intent.id].state,
                        "unknown"
                    );
                    assert_eq!(
                        e.cache["chat:a"].pending.as_deref(),
                        Some(intent.id.as_str()),
                        "Private failure must keep the exact pending reader anchor"
                    );
                })
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                // Local's acceptance is not reported as an unconfirmed send.
                assert_eq!(
                    w.find("delivery-recovery-status").label(),
                    Some("Sent. Pilot couldn't save the receipt.")
                );
                let b = w.find("delivery-diagnostic").bounds();
                let tray = gpui_kit::Bounds::new(Default::default(), w.viewport_size());
                assert!(
                    b.left() >= tray.left()
                        && b.right() <= tray.right()
                        && b.bottom() <= tray.bottom()
                );
                assert!(w.find("delivery-diagnostic").visible());
                for id in ["check-delivery", "retry-delivery"] {
                    let target = w.find(id);
                    assert!(
                        target.visible(),
                        "{id} must remain reachable in contextual Recovery"
                    );
                    let bounds = target.bounds();
                    assert!(
                        bounds.size.height > px(0.)
                            && bounds.top() >= tray.top()
                            && bounds.bottom() <= tray.bottom()
                    );
                }
                assert_eq!(cx.theme().mode, mode);
            })
            .unwrap();
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{}-{}-unsaved-ack.png", width as u32, mode.name())))
                    .unwrap();
            }
            assert!(commands.try_recv().is_err());
            assert_eq!(
                serde_json::to_vec(store.book.pending[&intent.id].operation.as_ref().unwrap())
                    .unwrap(),
                original
            );
            // A routine successful send retains its diagnostic without mounting
            // any recovery row, stale receipt notice or copy/disclosure control.
            for outcome in ["accepted", "rejected"] {
                let key = format!("chat:{outcome}");
                let mut book = store.book.clone();
                let mut settled = delivery.clone();
                settled.state = outcome.into();
                settled.diagnostic = Some(Diagnostic {
                    stage: Stage::Execute,
                    category: if outcome == "accepted" {
                        Category::Accepted
                    } else {
                        Category::Rejected
                    },
                    status: Some(200),
                    acknowledgment: if outcome == "accepted" {
                        Acknowledgment::Accepted
                    } else {
                        Acknowledgment::Rejected
                    },
                });
                book.drafts.insert(
                    key.clone(),
                    Draft {
                        last: Some(settled.clone()),
                        text: if outcome == "rejected" {
                            "Keep rejected draft 👩‍💻".into()
                        } else {
                            String::new()
                        },
                        ..Default::default()
                    },
                );
                cx.update_window(h, |_, w, cx| {
                    // Close the existing contextual disclosure before navigation.
                    w.press("escape", cx);
                    editor.update(cx, |e, cx| {
                        e.accept(
                            WriteState {
                                book: Some(Arc::new(book)),
                                notice: "Receipt accepted. Original intent retained.",
                                notice_key: Some(key.clone()),
                                delivery_notice: Some(intent.id.clone()),
                                ..Default::default()
                            },
                            w,
                            cx,
                        );
                        e.select(key.clone(), true, false, w, cx);
                    });
                })
                .unwrap();
                frame(cx, h);
                cx.update_window(h, |_, w, cx| {
                    assert!(w.try_find("delivery-diagnostic").is_none());
                    assert!(w.try_find("copy-recovered").is_none());
                    assert!(editor.read(cx).cache[&key].last.as_ref() == Some(&settled));
                    if outcome == "accepted" {
                        assert!(w.try_find("composer-recovery-region").is_none());
                        assert!(w.try_find("composer-recovery").is_none());
                    } else {
                        assert_eq!(
                            w.find("delivery-recovery-status").label(),
                            Some("This message wasn't sent. Edit it and send again.")
                        );
                        assert!(w.find("composer-recovery").visible());
                        assert_eq!(
                            editor.read(cx).text.read(cx).value().as_ref(),
                            "Keep rejected draft 👩‍💻"
                        );
                    }
                })
                .unwrap();
                if let Some(dir) = &captures {
                    cx.capture_screenshot(h)
                        .unwrap()
                        .save(dir.join(format!("{}-{}-{outcome}.png", width as u32, mode.name())))
                        .unwrap();
                }
            }
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
            drop(store);
            std::fs::remove_dir_all(root).unwrap();
            println!(
                "delivery_diagnostics {} {} passed: exact/retained/unsaved-ack/wrap/keyboard/pointer",
                width as u32,
                mode.name()
            );
        }
    }
}
