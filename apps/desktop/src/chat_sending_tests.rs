use super::super::tests::setup;
use super::*;
use crate::delivery_store::Store;
use crate::interaction::{WriteCommand, WriteState};
use gpui_kit::{AnyWindowHandle, AppContext, Entity, TestAppContext, test::TestWindowExt};
use std::sync::Arc;

const TEXT: &str = "Ship it 👩‍💻 e\u{301}";

struct Sent {
    handle: AnyWindowHandle,
    view: Entity<ChatEditor>,
    store: Store,
    request: u64,
    intent: String,
}

fn shown(cx: &mut TestAppContext, view: &Entity<ChatEditor>) -> String {
    cx.update(|cx| view.read(cx).text.read(cx).value().to_string())
}
fn sending(cx: &mut TestAppContext, view: &Entity<ChatEditor>) -> Option<Sending> {
    cx.update(|cx| view.read(cx).sending("a"))
}
fn accept(cx: &mut TestAppContext, sent: &Sent, handled: bool) {
    let mut state = WriteState {
        book: Some(Arc::new(sent.store.book.clone())),
        ..Default::default()
    };
    if handled {
        state.handled.insert("chat:a".into(), sent.request);
    }
    cx.update_window(sent.handle, |_, w, cx| {
        sent.view.update(cx, |e, cx| e.accept(state, w, cx));
        w.render_frame(cx);
    })
    .unwrap();
}
fn recovery_status(cx: &mut TestAppContext, handle: AnyWindowHandle) -> Option<String> {
    cx.update_window(handle, |_, w, cx| {
        w.render_frame(cx);
        w.try_find("delivery-recovery-status")
            .and_then(|e| e.label().map(str::to_owned))
    })
    .unwrap()
}

/// Real typing and Return, then Local reserves the operation (still in flight).
fn send(cx: &mut TestAppContext) -> Sent {
    let (handle, view, commands) = setup(cx);
    cx.update_window(handle, |_, w, cx| {
        w.render_frame(cx);
        w.input(TEXT, cx);
        w.press("enter", cx);
    })
    .unwrap();
    cx.run_until_parked();
    let WriteCommand::Submit {
        key,
        draft,
        request,
        stop: false,
        ..
    } = commands.try_recv().unwrap()
    else {
        panic!("expected an ordinary submit");
    };
    assert_eq!((key.as_str(), draft.text.as_str()), ("chat:a", TEXT));
    // Immediately: the conversation has it; the durable draft still holds it.
    assert_eq!(shown(cx, &view), "");
    assert_eq!(
        cx.update(|cx| view.read(cx).cache["chat:a"].text.clone()),
        TEXT
    );
    assert_eq!(
        sending(cx, &view).map(|s| (s.text, s.status)),
        Some((TEXT.to_owned(), "Sending…"))
    );
    let root = std::env::temp_dir().join(format!("chat-sending-{}", uuid::Uuid::new_v4()));
    let mut store = Store::open(
        root,
        cx.update(|cx| view.read(cx).state.book.as_ref().unwrap().host.clone()),
    )
    .unwrap();
    let intent = store.prepare("chat:a", &draft, false, false).unwrap().id;
    let sent = Sent {
        handle,
        view,
        store,
        request,
        intent,
    };
    let before = sending(cx, &sent.view).unwrap().key;
    accept(cx, &sent, false);
    let reserved = sending(cx, &sent.view).unwrap();
    assert_eq!(
        (reserved.key, reserved.status),
        (before, "Sending…"),
        "same row, no flicker"
    );
    assert_eq!(shown(cx, &sent.view), "");
    assert_eq!(
        recovery_status(cx, sent.handle),
        None,
        "in flight is not an unconfirmed send"
    );
    sent
}

#[gpui_kit::test]
fn accepted_send_leaves_the_composer_empty(cx: &mut TestAppContext) {
    let mut sent = send(cx);
    sent.store
        .finish(&sent.intent.clone(), "accepted", None)
        .unwrap();
    accept(cx, &sent, true);
    assert_eq!(shown(cx, &sent.view), "");
    // Accepted keeps the same row, with the exact text, until the conversation
    // shows it from Local.
    let accepted = sending(cx, &sent.view).unwrap();
    assert_eq!((accepted.text.as_str(), accepted.status), (TEXT, "Sent"));
    // Unrelated write states keep it; only the conversation forgets it.
    accept(cx, &sent, true);
    assert_eq!(sending(cx, &sent.view), Some(accepted));
    cx.update(|cx| sent.view.update(cx, |e, _| e.forget_sent("a")));
    assert_eq!(sending(cx, &sent.view), None);
    assert_eq!(
        cx.update(|cx| sent.view.read(cx).cache["chat:a"].text.clone()),
        ""
    );
}

#[gpui_kit::test]
fn rejected_send_returns_its_exact_text_to_the_composer(cx: &mut TestAppContext) {
    let mut sent = send(cx);
    sent.store
        .finish(&sent.intent.clone(), "rejected", None)
        .unwrap();
    accept(cx, &sent, true);
    assert_eq!(shown(cx, &sent.view), TEXT);
    assert_eq!(
        sending(cx, &sent.view),
        None,
        "a rejected send is never Sent"
    );
    assert_rejected_status(cx, &sent);
}

#[gpui_kit::test]
fn accepted_send_stays_even_when_its_reservation_was_never_shown(cx: &mut TestAppContext) {
    // The worker coalesces write states, so the reserved state can be skipped.
    let (handle, view, commands) = setup(cx);
    cx.update_window(handle, |_, w, cx| {
        w.render_frame(cx);
        w.input(TEXT, cx);
        w.press("enter", cx);
    })
    .unwrap();
    cx.run_until_parked();
    let WriteCommand::Submit { draft, request, .. } = commands.try_recv().unwrap() else {
        panic!("expected submit");
    };
    let root = std::env::temp_dir().join(format!("chat-sending-{}", uuid::Uuid::new_v4()));
    let host = cx.update(|cx| view.read(cx).state.book.as_ref().unwrap().host.clone());
    let mut store = Store::open(root, host).unwrap();
    let intent = store.prepare("chat:a", &draft, false, false).unwrap().id;
    store.finish(&intent, "accepted", None).unwrap();
    let mut state = WriteState {
        book: Some(Arc::new(store.book.clone())),
        ..Default::default()
    };
    state.handled.insert("chat:a".into(), request);
    cx.update_window(handle, |_, w, cx| {
        view.update(cx, |e, cx| e.accept(state, w, cx))
    })
    .unwrap();
    assert_eq!(
        sending(cx, &view).map(|s| (s.text, s.status)),
        Some((TEXT.to_owned(), "Sent"))
    );
    assert_eq!(shown(cx, &view), "");
}

fn assert_rejected_status(cx: &mut TestAppContext, sent: &Sent) {
    assert_eq!(
        recovery_status(cx, sent.handle).as_deref(),
        Some("This message wasn't sent. Edit it and send again.")
    );
}

#[gpui_kit::test]
fn rejected_send_keeps_recovery_after_navigation(cx: &mut TestAppContext) {
    let mut sent = send(cx);
    sent.store
        .finish(&sent.intent.clone(), "rejected", None)
        .unwrap();
    accept(cx, &sent, true);
    cx.update_window(sent.handle, |_, w, cx| {
        sent.view.update(cx, |e, cx| {
            e.select("chat:b".into(), true, false, w, cx);
            e.select("chat:a".into(), true, false, w, cx);
        })
    })
    .unwrap();
    assert_eq!(shown(cx, &sent.view), TEXT);
    assert_eq!(sending(cx, &sent.view), None);
    assert_rejected_status(cx, &sent);
}

#[gpui_kit::test]
fn unknown_outcome_stays_in_the_conversation_with_recovery(cx: &mut TestAppContext) {
    let sent = send(cx);
    accept(cx, &sent, true);
    assert_eq!(shown(cx, &sent.view), "");
    assert_eq!(
        sending(cx, &sent.view).map(|s| s.status),
        Some("Not confirmed")
    );
    assert_eq!(
        recovery_status(cx, sent.handle).as_deref(),
        Some("Couldn't confirm this message was sent.")
    );
    // Typing a new message replaces only the composer; the uncertain send stays.
    cx.update_window(sent.handle, |_, w, cx| {
        sent.view.update(cx, |e, cx| e.focus(w, cx));
        w.render_frame(cx);
        w.input("next", cx);
    })
    .unwrap();
    assert_eq!(shown(cx, &sent.view), "next");
    assert_eq!(
        sending(cx, &sent.view).map(|s| (s.text, s.status)),
        Some((TEXT.to_owned(), "Not confirmed"))
    );
}

#[gpui_kit::test]
fn refusal_before_reservation_restores_the_draft(cx: &mut TestAppContext) {
    let (handle, view, commands) = setup(cx);
    cx.update_window(handle, |_, w, cx| {
        w.render_frame(cx);
        w.input(TEXT, cx);
        w.press("enter", cx);
    })
    .unwrap();
    cx.run_until_parked();
    let WriteCommand::Submit { request, .. } = commands.try_recv().unwrap() else {
        panic!("expected submit");
    };
    assert_eq!(shown(cx, &view), "");
    let mut state = WriteState {
        book: cx.update(|cx| view.read(cx).state.book.clone()),
        error: None,
        notice: "A model switch is unconfirmed.",
        ..Default::default()
    };
    state.handled.insert("chat:a".into(), request);
    cx.update_window(handle, |_, w, cx| {
        view.update(cx, |e, cx| e.accept(state, w, cx))
    })
    .unwrap();
    assert_eq!(shown(cx, &view), TEXT);
    assert_eq!(sending(cx, &view), None);
}

#[gpui_kit::test]
fn stop_and_new_chat_drafts_stay_in_the_composer(cx: &mut TestAppContext) {
    let (handle, view, commands) = setup(cx);
    cx.update_window(handle, |_, w, cx| {
        view.update(cx, |e, cx| e.permission(true, true, cx));
        w.render_frame(cx);
        w.input("keep me", cx);
        w.click("local-stop", cx);
    })
    .unwrap();
    cx.run_until_parked();
    assert!(matches!(
        commands.try_recv().unwrap(),
        WriteCommand::Submit { stop: true, .. }
    ));
    assert_eq!(shown(cx, &view), "keep me");
    assert_eq!(sending(cx, &view), None);
}
