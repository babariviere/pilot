//! Mounted production composer + courier, private state and held faux Stop only.
use super::*;
use crate::{LocalOptions, delivery_store::Store};
use gpui_kit::{
    AnyWindowHandle, Bounds, ElementInputHandler, HeadlessAppContext, WindowBounds, WindowOptions,
    component::ThemeMode,
    size,
    test::{TestInput, TestQueryExt, TestWindowExt},
};
use serde_json::json;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};

struct Server {
    options: LocalOptions,
    entered: async_channel::Receiver<()>,
    release: async_channel::Sender<()>,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    fn start(lost: bool) -> Self {
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let (shutdown, done) = tokio::sync::oneshot::channel();
        let (entered, reached) = async_channel::bounded(1);
        let (release, released) = async_channel::bounded(1);
        let thread = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async move {
                let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await.unwrap();
                send.send(LocalOptions::synthetic(listener.local_addr().unwrap().port())).unwrap();
                let mut tasks = tokio::task::JoinSet::new();
                tokio::pin!(done);
                loop { tokio::select! {
                    _ = &mut done => break,
                    accepted = listener.accept() => {
                        let (stream, _) = accepted.unwrap();
                        let entered = entered.clone(); let released = released.clone();
                        tasks.spawn(async move {
                            let mut reader = BufReader::new(stream); let mut first = String::new();
                            if reader.read_line(&mut first).await.unwrap() == 0 { return; }
                            let words: Vec<_> = first.split_whitespace().collect();
                            let (method, path) = (words[0], words[1]);
                            let mut length = 0;
                            loop {
                                let mut line = String::new(); reader.read_line(&mut line).await.unwrap();
                                if line == "\r\n" { break; }
                                if let Some(s) = line.to_ascii_lowercase().strip_prefix("content-length:") { length = s.trim().parse::<usize>().unwrap(); }
                                assert!(length < 1024);
                            }
                            let mut bytes = vec![0;length]; reader.read_exact(&mut bytes).await.unwrap();
                            let stop = method == "POST" && path == "/api/sessions/a/stop";
                            let body = match (method,path) {
                                ("GET", "/api/hello") => json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}),
                                ("GET", "/api/sessions/a") => json!({"id":"a","mode":"build","state":"working"}),
                                ("POST", "/api/sessions/a/stop") => {
                                    assert_eq!(bytes,b"{}");
                                    entered.send(()).await.unwrap();
                                    if released.recv().await.is_err() || lost { return; }
                                    json!({"ok":true,"draft":"Withdrawn queued input"})
                                },
                                _ => panic!("Unexpected Stop fixture route {method} {path}"),
                            }.to_string();
                            let status = if stop {"202 Accepted"} else {"200 OK"};
                            let _ = reader.into_inner().write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await;
                        });
                    },
                    _ = tasks.join_next(), if !tasks.is_empty() => {},
                }}
            });
        });
        Self {
            options: receive.recv_timeout(Duration::from_secs(3)).unwrap(),
            entered: reached,
            release,
            shutdown: Some(shutdown),
            thread: Some(thread),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.shutdown.take().unwrap().send(());
        self.thread.take().unwrap().join().unwrap();
    }
}
struct Private(PathBuf);
impl Drop for Private {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
}
struct Root(Entity<ChatEditor>);
impl Render for Root {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .v_flex()
            .bg(cx.theme().background)
            .child(div().flex_1())
            .child(self.0.clone())
    }
}
fn pump(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    editor: &Entity<ChatEditor>,
    updates: &async_channel::Receiver<WriteState>,
) {
    while let Ok(state) = updates.try_recv() {
        cx.update_window(h, |_, w, cx| {
            editor.update(cx, |e, cx| e.accept(state, w, cx))
        })
        .unwrap();
    }
    cx.run_until_parked();
    cx.advance_clock(Duration::from_millis(16));
    cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
}
fn until(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    editor: &Entity<ChatEditor>,
    updates: &async_channel::Receiver<WriteState>,
    condition: impl Fn(&ChatEditor) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(6);
    while !cx.update(|cx| condition(editor.read(cx))) {
        assert!(Instant::now() < deadline, "bounded held Stop publication");
        pump(cx, h, editor, updates);
        std::thread::yield_now();
    }
    pump(cx, h, editor, updates);
}
fn disk(private: &Private) -> crate::delivery_store::Book {
    serde_json::from_slice(&std::fs::read(private.0.join("state-v1.json")).unwrap()).unwrap()
}
pub(super) fn run(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            for lost in [false, true] {
                let server = Server::start(lost);
                let private = Private(
                    std::env::temp_dir().join(format!("native-stop-wait-{}", uuid::Uuid::new_v4())),
                );
                let question = crate::question::Question::parse(7,&json!({"question":"Existing question?","options":[{"label":"Keep"}],"blocking":true})).unwrap();
                let captured = Draft {
                    revision: 2,
                    text: "Unsent ordinary 日本語 👩‍💻".into(),
                    cwd: "/synthetic".into(),
                    project_id: Some("project-a".into()),
                    answer: Some(
                        crate::question::AnswerDraft::capture(
                            &question,
                            2,
                            BTreeSet::from([0]),
                            "Existing answer".into(),
                        )
                        .unwrap(),
                    ),
                    ..Default::default()
                };
                Store::open(private.0.clone(), server.options.host())
                    .unwrap()
                    .save_edits(BTreeMap::from([("chat:a".into(), captured.clone())]))
                    .unwrap();
                let (writer, updates) =
                    Interaction::start(server.options.clone(), Ok(private.0.clone()));
                let (h, editor) = cx.update(|cx| {
                    let mut editor = None;
                    let (h, _) = gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(520.)),
                            ))),
                            show: false,
                            focus: false,
                            ..Default::default()
                        },
                        cx,
                        |w, cx| {
                            w.set_rem_size(px(14.));
                            let e = cx.new(|cx| ChatEditor::new(Some(writer.clone()), w, cx));
                            editor = Some(e.clone());
                            cx.new(|_| Root(e))
                        },
                    )
                    .unwrap();
                    // Window-open system appearance synchronization runs first.
                    gpui_kit::component::Theme::change(mode, None, cx);
                    (h, editor.unwrap())
                });
                until(cx, h, &editor, &updates, |e| e.ready());
                cx.update_window(h, |_, w, cx| {
                    assert_eq!(cx.theme().mode, mode);
                    editor.update(cx, |e, cx| e.select("chat:a".into(), true, true, w, cx));
                    w.render_frame(cx);
                    w.click("local-stop", cx);
                })
                .unwrap();
                let deadline = Instant::now() + Duration::from_secs(5);
                while server.entered.try_recv().is_err() {
                    assert!(Instant::now() < deadline);
                    pump(cx, h, &editor, &updates);
                    std::thread::yield_now();
                }
                let original = disk(&private).pending.values().next().unwrap().clone();
                let text = "Newer unsent e\u{301} 日本語 🦀";
                let started = Instant::now();
                cx.update_window(h, |_, w, cx| {
                    w.click("composer-input", cx);
                    w.press("secondary-a", cx);
                    w.input(text, cx);
                })
                .unwrap();
                until(cx, h, &editor, &updates, |e| {
                    e.state
                        .book
                        .as_ref()
                        .is_some_and(|b| b.drafts["chat:a"].text == text)
                });
                let before = disk(&private);
                assert_eq!(before.drafts["chat:a"].text, text);
                assert!(before.pending[&original.id] == original);
                assert!(before.drafts["chat:a"].answer == captured.answer);
                assert_eq!(before.drafts["chat:a"].cwd, captured.cwd);
                assert_eq!(before.drafts["chat:a"].project_id, captured.project_id);
                assert!(cx.update(|cx| editor.read(cx).state.handled.is_empty()));
                let elapsed = started.elapsed();
                // Preserve preedit/selection/focus through an autosave snapshot.
                cx.update_window(h, |_, w, cx| {
                    assert_eq!(w.find_by_label("Message to Pilot").focused(), Some(true));
                    let handler = ElementInputHandler::new(
                        w.find_by_label("Message to Pilot").bounds(),
                        editor.read(cx).text.clone(),
                    );
                    TestInput::new(handler, w).compose_text(None, "にほん", Some(3..3), cx);
                    editor.update(cx, |e, cx| {
                        let state = e.state.clone();
                        e.accept(state, w, cx);
                        assert!(e.marked(w, cx));
                    });
                })
                .unwrap();
                // Change visible target while A is waiting. Its ACK must not retarget B.
                cx.update_window(h, |_, w, cx| {
                    editor.update(cx, |e, cx| {
                        e.text.update(cx, |input, cx| input.unmark_text(w, cx));
                        e.changed(cx);
                        e.select("chat:b".into(), true, false, w, cx);
                        e.focus(w, cx);
                    })
                })
                .unwrap();
                pump(cx, h, &editor, &updates);
                cx.update_window(h, |_, w, cx| w.input("Other target unsent 日本語", cx))
                    .unwrap();
                until(cx, h, &editor, &updates, |e| {
                    e.state.book.as_ref().is_some_and(|b| {
                        b.drafts
                            .get("chat:b")
                            .is_some_and(|d| d.text == "Other target unsent 日本語")
                    })
                });
                cx.update_window(h, |_, w, cx| {
                    let handler = ElementInputHandler::new(
                        w.find_by_label("Message to Pilot").bounds(),
                        editor.read(cx).text.clone(),
                    );
                    TestInput::new(handler, w).compose_text(None, "とうきょう", Some(5..5), cx);
                })
                .unwrap();
                server.release.send_blocking(()).unwrap();
                until(cx, h, &editor, &updates, |e| {
                    e.state.handled.get("chat:a") == Some(&1)
                });
                cx.update_window(h, |_, w, cx| {
                    assert!(editor.update(cx, |e, cx| e.marked(w, cx)));
                    let e = editor.read(cx);
                    assert_eq!(e.selected.as_deref(), Some("chat:b"));
                    assert_eq!(w.find_by_label("Message to Pilot").focused(), Some(true));
                    assert_eq!(
                        e.text.read(cx).value().as_str(),
                        e.shown_text("chat:b", &e.cache["chat:b"])
                    );
                    assert_eq!(
                        e.cache["chat:b"].text,
                        "Other target unsent 日本語とうきょう"
                    );
                    assert!(e.cache["chat:a"].answer == captured.answer);
                    if lost {
                        assert!(e.state.book.as_ref().unwrap().pending[&original.id] == original);
                    } else {
                        assert!(e.state.book.as_ref().unwrap().pending.is_empty());
                    }
                })
                .unwrap();
                cx.update_window(h, |_, w, cx| {
                    editor.update(cx, |e, cx| {
                        e.text.update(cx, |input, cx| input.unmark_text(w, cx));
                        e.changed(cx);
                    })
                })
                .unwrap();
                assert!(writer.command(WriteCommand::Close));
                until(cx, h, &editor, &updates, |e| e.state.flushed);
                cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
                writer.disconnect_fixture();
                let deadline = Instant::now() + Duration::from_secs(5);
                while !updates.is_closed() {
                    assert!(
                        Instant::now() < deadline,
                        "writer disconnect releases Store"
                    );
                    cx.run_until_parked();
                    std::thread::yield_now();
                }
                let reopened = Store::open(private.0.clone(), server.options.host()).unwrap();
                assert_eq!(
                    reopened.book.drafts["chat:b"].text,
                    "Other target unsent 日本語とうきょう"
                );
                assert!(reopened.book.drafts["chat:a"].text.starts_with(text));
                println!(
                    "{}",
                    json!({"probe":"stop-wait","width":width,"mode":mode.name(),"lost_ack":lost,"durable_before_release":true,"edit_to_saved_ms":elapsed.as_secs_f64()*1000.})
                );
            }
        }
    }
}
