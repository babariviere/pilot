use super::*;
use crate::scoped_models::{Reply, hash};
use gpui_kit::{TestAppContext, WindowOptions};
fn setup(cx: &mut TestAppContext) -> (gpui_kit::AnyWindowHandle, Entity<ScopedModels>) {
    cx.update(gpui_kit::init);
    cx.update(|cx| {
        gpui_kit::open_window(WindowOptions::default(), cx, |w, cx| {
            cx.new(|cx| ScopedModels::new(None, w, cx))
        })
        .unwrap()
    })
}
fn snapshot(patterns: Option<Vec<String>>) -> Snapshot {
    serde_json::from_value(crate::scoped_models_fixture::snapshot(&patterns)).unwrap()
}
#[gpui_kit::test]
fn current_values_and_external_check_preserve_literal_edit_and_cas_baseline(
    cx: &mut TestAppContext,
) {
    let (h, v) = setup(cx);
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            v.accept(
                Update(
                    0,
                    Reply {
                        observation: Ok(snapshot(Some(vec![]))),
                        problem: None,
                        attempted: false,
                    },
                ),
                w,
                cx,
            );
            assert!(v.all);
            assert!(!v.unsettled(cx));
            assert_eq!(v.baseline.as_ref().unwrap().scope_hash, hash(&Some(vec![])));
            v.all = false;
            v.patterns.update(cx, |t, cx| {
                t.set_value("p/*:high\np/unavailable\np/unavailable", w, cx)
            });
            v.edited = true;
            let original = v.selection(cx);
            let old = v.baseline.as_ref().unwrap().scope_hash.clone();
            v.accept(
                Update(
                    0,
                    Reply {
                        observation: Ok(snapshot(Some(vec!["p/external".into()]))),
                        problem: None,
                        attempted: false,
                    },
                ),
                w,
                cx,
            );
            assert_eq!(v.selection(cx), original);
            assert_eq!(v.baseline.as_ref().unwrap().scope_hash, old);
            v.revert(w, cx);
            assert_eq!(v.selection(cx), original);
            assert!(v.confirm_revert);
            v.revert(w, cx);
            assert_eq!(v.selection(cx), Some(vec!["p/external".into()]));
            assert!(!v.unsettled(cx));
        })
    })
    .unwrap();
    cx.run_until_parked();
    cx.update(|cx| assert!(!v.read(cx).unsettled(cx)));
}
#[gpui_kit::test]
fn preflight_refusal_is_not_uncertain_and_lost_put_requires_readback_or_explicit_review(
    cx: &mut TestAppContext,
) {
    let (h, v) = setup(cx);
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            v.apply(snapshot(None), w, cx);
            v.observed = v.baseline.clone();
            v.all = false;
            v.patterns.update(cx, |t, cx| t.set_value("p/one", w, cx));
            v.edited = true;
            let save = Save {
                enabled_models: v.selection(cx),
                expected_hash: hash(&None),
            };
            v.pending = Some(save.clone());
            v.active_save = true;
            v.accept(
                Update(
                    0,
                    Reply {
                        observation: Err("Native authorization unavailable"),
                        problem: None,
                        attempted: false,
                    },
                ),
                w,
                cx,
            );
            assert!(v.pending.is_none());
            assert!(!v.unconfirmed);
            assert!(v.unsettled(cx));
            v.pending = Some(save);
            v.active_save = true;
            v.accept(
                Update(
                    0,
                    Reply {
                        observation: Err("Lost response and readback"),
                        problem: None,
                        attempted: true,
                    },
                ),
                w,
                cx,
            );
            assert!(v.unconfirmed);
            assert!(v.pending.is_some());
            assert!(!v.editable());
            v.active_save = false;
            v.accept(
                Update(
                    0,
                    Reply {
                        observation: Ok(snapshot(Some(vec!["p/one".into()]))),
                        problem: None,
                        attempted: false,
                    },
                ),
                w,
                cx,
            );
            assert!(!v.unconfirmed);
            assert!(v.pending.is_none());
            assert_eq!(v.selection(cx), Some(vec!["p/one".into()]));
            v.accept(
                Update(
                    999,
                    Reply {
                        observation: Ok(snapshot(None)),
                        problem: None,
                        attempted: false,
                    },
                ),
                w,
                cx,
            );
            assert_eq!(v.selection(cx), Some(vec!["p/one".into()]));
        })
    })
    .unwrap();
}
#[gpui_kit::test]
fn marked_native_patterns_refuse_save_check_and_discard_without_losing_preedit(
    cx: &mut TestAppContext,
) {
    let (h, v) = setup(cx);
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            v.source = Some(LocalOptions::synthetic(1));
            v.apply(snapshot(Some(vec!["p/one".into()])), w, cx);
            v.observed = v.baseline.clone();
            v.patterns.update(cx, |t, cx| {
                t.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
            });
            let request = v.request;
            let text = v.patterns.read(cx).value();
            v.save(w, cx);
            v.check(w, cx);
            v.revert(w, cx);
            assert_eq!(v.request, request);
            assert_eq!(v.patterns.read(cx).value(), text);
            assert!(v.marked(w, cx));
            assert!(v.worker.is_none());
        })
    })
    .unwrap();
}

#[gpui_kit::test]
fn matching_readback_does_not_overwrite_newer_native_input_before_readonly_paint(
    cx: &mut TestAppContext,
) {
    let (h, v) = setup(cx);
    cx.update_window(h, |_, w, cx| {
        v.update(cx, |v, cx| {
            v.apply(snapshot(None), w, cx);
            v.observed = v.baseline.clone();
            v.all = false;
            v.patterns.update(cx, |t, cx| t.set_value("p/one", w, cx));
            v.edited = true;
            v.pending = Some(Save {
                enabled_models: Some(vec!["p/one".into()]),
                expected_hash: hash(&None),
            });
            v.pending_text = Some("p/one".into());
            v.active_save = true;
            // A delayed native commit can arrive before the readonly frame paints.
            v.patterns.update(cx, |t, cx| {
                t.replace_text_in_range(Some(0..5), "p/two", w, cx)
            });
            v.accept(
                Update(
                    0,
                    Reply {
                        observation: Ok(snapshot(Some(vec!["p/one".into()]))),
                        problem: None,
                        attempted: true,
                    },
                ),
                w,
                cx,
            );
            assert_eq!(v.selection(cx), Some(vec!["p/two".into()]));
            assert!(v.pending.is_none());
            assert!(!v.unconfirmed);
            assert!(v.unsettled(cx));
            assert_eq!(
                v.baseline.as_ref().unwrap().enabled_models,
                Some(vec!["p/one".into()])
            );
        })
    })
    .unwrap();
}
