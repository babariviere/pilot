//! Real Actions admission/completion with owned synthetic HTTP, no viewer data.
use super::*;
use crate::chat_actions::{Action, Evidence, Outcome, Target};
use crate::chat_actions_view::Actions;

pub(super) fn run(cx: &mut HeadlessAppContext) {
    let server = Server::start(Behavior::Accept);
    let (h, actions) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                show: false,
                focus: false,
                ..Default::default()
            },
            cx,
            |_, cx| {
                cx.new(|cx| {
                    let mut a = Actions::new(cx);
                    a.connect(server.options.clone(), cx);
                    a
                })
            },
        )
        .unwrap()
    });
    let evidence = |id: &str, behavior| {
        let mut s = server.seen.lock().unwrap();
        s.source = f::source();
        s.source["id"] = json!(id);
        s.behavior = behavior;
        Evidence::read(
            &Target::new(
                &server.options,
                crate::local_model::chat(&s.source).unwrap(),
            ),
            &s.source,
            true,
        )
        .unwrap()
    };
    let submit = |cx: &mut HeadlessAppContext, e: Evidence| {
        cx.update_window(h, |_, w, cx| {
            actions.update(cx, |a, cx| a.submit(e, Action::Archive, w, cx))
        })
        .unwrap();
    };
    // More than sixteen distinct ACKs AND rejections, plus same-chat repeats.
    for n in 0..40 {
        let id = format!("completed-{n}");
        let e = evidence(&id, Behavior::Accept);
        submit(cx, e.clone());
        until(cx, h, |_, cx| {
            actions.read(cx).outcome(&id) == Some(&Outcome::Acknowledged)
        });
        cx.update(|cx| {
            let a = actions.read(cx);
            assert!(!a.blocked(&id));
            assert!(a.read_only(&id));
            #[cfg(target_os = "macos")]
            assert!(a.restart_safe());
        });
        // Same target, fresh evidence; reject before POST by changing its stamp.
        let mut stale = evidence(&id, Behavior::Accept);
        stale.stamp["updatedAt"] = json!(999);
        submit(cx, stale);
        until(cx, h, |_, cx| {
            matches!(actions.read(cx).outcome(&id), Some(Outcome::Rejected(_)))
        });
        cx.update(|cx| {
            assert!(!actions.read(cx).read_only(&id));
            #[cfg(target_os = "macos")]
            assert!(actions.read(cx).restart_safe());
        });
    }
    assert_eq!(server.posts(), 40);
    let pending = evidence("pending", Behavior::Slow);
    submit(cx, pending.clone());
    until(cx, h, |_, _| server.posts() == 41);
    cx.update(|cx| {
        let a = actions.read(cx);
        assert!(a.blocked("pending") && a.blocked("unseen"));
        assert!(a.read_only("pending"));
        #[cfg(target_os = "macos")]
        assert!(!a.restart_safe());
    });
    submit(cx, pending.clone());
    let mut other = pending.clone();
    other.target.chat.id = "unseen".into();
    submit(cx, other);
    assert_eq!(server.posts(), 41);
    server.released.notify_one();
    until(cx, h, |_, cx| {
        actions.read(cx).outcome("pending") == Some(&Outcome::Acknowledged)
    });
    cx.update(|cx| {
        actions.update(cx, |a, _| {
            a.inspected(&pending, None);
            assert!(a.read_only("pending"));
            let ack = a.inspection_ack("pending");
            assert!(ack.is_some());
            a.inspected(&pending, ack);
            assert!(!a.read_only("pending"));
        })
    });
    let unknown = evidence("unknown", Behavior::Lost);
    submit(cx, unknown.clone());
    until(cx, h, |_, cx| {
        actions.read(cx).outcome("unknown") == Some(&Outcome::Unknown)
    });
    for n in 0..20 {
        let id = format!("after-unknown-{n}");
        submit(cx, evidence(&id, Behavior::Accept));
        until(cx, h, |_, cx| {
            actions.read(cx).outcome(&id) == Some(&Outcome::Acknowledged)
        });
        cx.update(|cx| {
            actions.update(cx, |a, _| {
                assert!(a.blocked("unknown"));
                assert!(a.read_only("unknown"));
                assert!(a.inspection_ack("unknown").is_none());
                a.inspected(&unknown, None);
                assert!(a.read_only("unknown"));
                #[cfg(target_os = "macos")]
                assert!(!a.restart_safe());
            })
        });
        submit(cx, unknown.clone());
    }
    assert_eq!(server.posts(), 62);
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    cx.run_until_parked();
    println!(
        "chat_actions_capacity: 40 distinct ACK/rejected pairs, repeats, pending, 20 post-Unknown completions, ACK fence and restart safety passed"
    );
}
