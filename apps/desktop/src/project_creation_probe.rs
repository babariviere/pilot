//! Actual production composer/project rows/courier over an owned faux daemon.
//! Offscreen component pixels are not full-app, OS IME or performance acceptance.
use super::*;
use crate::{
    LocalOptions, local_model,
    ui::{self, Text},
};
use gpui_kit::{
    AnyWindowHandle, Bounds, HeadlessAppContext, WindowBounds, WindowOptions,
    component::{Theme, ThemeMode},
    size,
    test::TestWindowExt,
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};

fn focus_project_search(
    editor: &Entity<ChatEditor>,
    w: &mut gpui_kit::Window,
    cx: &mut gpui_kit::App,
) {
    let query = editor.read(cx).project_query(cx).unwrap();
    query.update(cx, |q, cx| q.focus(w, cx));
}
fn catalog() -> Value {
    json!([
        {"id":"project-a","name":"Same project title 日本語","path":"/synthetic/shared"},
        {"id":"project-ab","name":"Same project title 日本語","path":"/synthetic/shared"},
        {"id":"long","name":"A deliberately long project title with Unicode 👩‍💻 日本語 and several words to constrain the real picker","path":"/synthetic/long-project"}
    ])
}
#[derive(Default)]
struct Seen {
    envelopes: Vec<Value>,
    receipts: std::collections::BTreeMap<String, Value>,
    projects: std::collections::BTreeMap<String, String>,
    lost: bool,
}
struct Server {
    options: LocalOptions,
    seen: Arc<Mutex<Seen>>,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    fn start(lost: bool) -> Self {
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let (shutdown, done) = tokio::sync::oneshot::channel();
        let thread = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async move {
                let listener=TcpListener::bind((std::net::Ipv4Addr::LOCALHOST,0)).await.unwrap();
                let options=LocalOptions::synthetic(listener.local_addr().unwrap().port());
                let seen=Arc::new(Mutex::new(Seen{lost,..Default::default()}));send.send((options,seen.clone())).unwrap();
                let mut tasks=tokio::task::JoinSet::new();tokio::pin!(done);
                loop {tokio::select! {_=&mut done=>break, accepted=listener.accept()=>{
                    let Ok((stream,_))=accepted else{break;};let seen=seen.clone();tasks.spawn(async move {
                        let mut reader=BufReader::new(stream);let mut first=String::new();if reader.read_line(&mut first).await.unwrap()==0{return;}
                        let words:Vec<_>=first.split_whitespace().collect();let (method,path)=(words[0].to_owned(),words[1].to_owned());let mut length=0;
                        loop {let mut line=String::new();if reader.read_line(&mut line).await.unwrap()==0{return;}
                            if line=="\r\n"{break;}
                            assert!(!line.to_ascii_lowercase().starts_with("origin:"));
                            if let Some(value)=line.to_ascii_lowercase().strip_prefix("content-length:"){length=value.trim().parse::<usize>().unwrap();}assert!(length<=64*1024);
                        }
                        let mut bytes=vec![0;length];reader.read_exact(&mut bytes).await.unwrap();let payload=if bytes.is_empty(){Value::Null}else{serde_json::from_slice::<Value>(&bytes).unwrap()};
                        let body={let mut s=seen.lock().unwrap();match (method.as_str(),path.as_str()) {
                            ("GET","/api/hello")=>json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}),
                            ("GET","/api/projects")=>catalog(),
                            ("POST","/api/operations/receipt")=>s.receipts.get(payload["operationId"].as_str().unwrap()).cloned().unwrap_or(json!({"state":"unknown"})),
                            ("POST","/api/operations")=>{
                                s.envelopes.push(payload.clone());assert_eq!(payload["kind"],"chat-create");
                                let request:Value=serde_json::from_str(payload["payload"].as_str().unwrap()).unwrap();
                                assert_eq!(request["projectId"],"project-ab");assert!(request.get("cwd").is_none());assert_eq!(request["mode"],"build");
                                let target=payload["targetId"].as_str().unwrap().to_owned();let id=payload["operationId"].as_str().unwrap().to_owned();
                                s.projects.entry(target.clone()).or_insert_with(||"project-ab".into());
                                let receipt=json!({"operationId":id,"payloadHash":payload["payloadHash"],"destination":payload["destination"],"targetId":target,"state":"accepted","result":{"sessionId":target}});
                                s.receipts.entry(id).or_insert_with(||receipt.clone());
                                if s.lost {s.lost=false;return;}
                                receipt
                            },
                            ("GET",path) if path.starts_with("/api/sessions/")=>{
                                let id=path.strip_prefix("/api/sessions/").unwrap();json!({"id":id,"projectId":s.projects.get(id),"cwd":"/synthetic/shared","mode":"build","state":"idle"})
                            },
                            _=>panic!("Unexpected project fixture route {method} {path}"),
                        }};
                        let body=body.to_string();let mut stream=reader.into_inner();let _=stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await;
                    });
                }}}
            });
        });
        let (options, seen) = receive.recv_timeout(Duration::from_secs(3)).unwrap();
        Self {
            options,
            seen,
            shutdown: Some(shutdown),
            thread: Some(thread),
        }
    }
    fn readback(&self, id: &str) -> Value {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                reqwest::Client::builder()
                    .no_proxy()
                    .timeout(Duration::from_secs(3))
                    .build()
                    .unwrap()
                    .get(format!("{}/api/sessions/{id}", self.options.loopback()))
                    .send()
                    .await
                    .unwrap()
                    .text()
                    .await
                    .map(|body| serde_json::from_str(&body).unwrap())
                    .unwrap()
            })
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        if let Some(stop) = self.shutdown.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}
struct Private(PathBuf);
impl Drop for Private {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
struct Root {
    editor: Entity<ChatEditor>,
}
impl Render for Root {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("project-create-root")
            .test_support()
            .size_full()
            .v_flex()
            .p_4()
            .gap_3()
            .bg(cx.theme().background)
            .child(ui::header(
                "project-create-title",
                "New Local chat",
                Text::Title,
            ))
            .child(self.editor.clone())
    }
}
fn pump(
    cx: &mut HeadlessAppContext,
    handle: AnyWindowHandle,
    editor: &Entity<ChatEditor>,
    updates: &async_channel::Receiver<WriteState>,
) {
    while let Ok(state) = updates.try_recv() {
        cx.update_window(handle, |_, w, cx| {
            editor.update(cx, |e, cx| e.accept(state, w, cx))
        })
        .unwrap();
    }
    for _ in 0..4 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(handle, |_, w, cx| w.render_frame(cx))
            .unwrap();
    }
}
fn until(
    cx: &mut HeadlessAppContext,
    handle: AnyWindowHandle,
    editor: &Entity<ChatEditor>,
    updates: &async_channel::Receiver<WriteState>,
    condition: impl Fn(&ChatEditor) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(6);
    while !cx.update(|cx| condition(editor.read(cx))) {
        assert!(
            Instant::now() < deadline,
            "bounded project creation publication"
        );
        pump(cx, handle, editor, updates);
        std::thread::yield_now();
    }
    pump(cx, handle, editor, updates);
}
fn capture(
    cx: &mut HeadlessAppContext,
    handle: AnyWindowHandle,
    dir: &Option<PathBuf>,
    name: String,
) {
    if let Some(dir) = dir {
        cx.capture_screenshot(handle)
            .unwrap()
            .save(dir.join(name))
            .unwrap();
    }
}
fn close(
    cx: &mut HeadlessAppContext,
    handle: AnyWindowHandle,
    writer: Interaction,
    updates: &async_channel::Receiver<WriteState>,
) {
    cx.update_window(handle, |_, w, _| w.remove_window())
        .unwrap();
    assert!(writer.command(WriteCommand::Close));
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            tokio::time::timeout(Duration::from_secs(3), async {
                let mut flushed = false;
                while let Ok(s) = updates.recv().await {
                    flushed |= s.flushed;
                }
                assert!(flushed);
            })
            .await
            .unwrap();
        });
    drop(writer);
}
pub fn run_project_creation_probe(cx: &mut HeadlessAppContext) {
    let dir = std::env::var_os("PILOT_NEXT_PROJECT_CREATE_DIR").map(PathBuf::from);
    if let Some(d) = &dir {
        std::fs::create_dir_all(d).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            for lost in [false, true] {
                let server = Server::start(lost);
                let private = Private(
                    std::env::temp_dir()
                        .canonicalize()
                        .unwrap()
                        .join(format!("native-project-private-{}", uuid::Uuid::new_v4())),
                );
                let (writer, updates) =
                    Interaction::start(server.options.clone(), Ok(private.0.clone()));
                cx.update(|cx| Theme::change(mode, None, cx));
                let (handle, editor) = cx.update(|cx| {
                    let mut editor = None;
                    let (handle, _root) = gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(760.)),
                            ))),
                            show: false,
                            focus: false,
                            ..Default::default()
                        },
                        cx,
                        |w, cx| {
                            let view = cx.new(|cx| ChatEditor::new(Some(writer.clone()), w, cx));
                            editor = Some(view.clone());
                            cx.new(|_| Root { editor: view })
                        },
                    )
                    .unwrap();
                    (handle, editor.unwrap())
                });
                until(cx, handle, &editor, &updates, ChatEditor::ready);
                cx.update_window(handle, |_, w, cx| {
                    editor.update(cx, |e, cx| e.new_draft(String::new(), w, cx))
                })
                .unwrap();
                pump(cx, handle, &editor, &updates);
                cx.update_window(handle, |_, w, cx| {
                    assert_eq!(w.find("local-send").disabled(), Some(true));
                    editor.update(cx, |e, cx| e.projects(Arc::default(), true, None, w, cx));
                })
                .unwrap();
                pump(cx, handle, &editor, &updates);
                cx.update_window(handle, |_, w, cx| {
                    assert_eq!(w.find("local-send").disabled(), Some(true));
                    editor.update(cx, |e, cx| {
                        e.projects(
                            Arc::new(local_model::projects(&catalog()).unwrap()),
                            true,
                            None,
                            w,
                            cx,
                        )
                    });
                })
                .unwrap();
                pump(cx, handle, &editor, &updates);
                cx.update_window(handle, |_, w, cx| {
                    let root = w.find("project-create-root").bounds();
                    let picker = w.find("new-chat-project").bounds();
                    assert_eq!(root.size.width, px(width));
                    assert!(picker.left() >= root.left() && picker.right() <= root.right());
                    assert!(
                        gpui_kit::base::test_support::snapshots(w)
                            .iter()
                            .all(|e| e.label() != Some("Local working folder"))
                    );
                    focus_project_search(&editor, w, cx);
                })
                .unwrap();
                pump(cx, handle, &editor, &updates);
                cx.update_window(handle, |_, w, cx| {
                    w.input("project-ab", cx);
                    w.press("escape", cx);
                })
                .unwrap();
                pump(cx, handle, &editor, &updates);
                cx.update(|cx| assert!(editor.read(cx).draft().unwrap().project_id.is_none()));
                cx.update_window(handle, |_, w, cx| focus_project_search(&editor, w, cx))
                    .unwrap();
                pump(cx, handle, &editor, &updates);
                cx.update_window(handle, |_, w, cx| w.input("project-ab", cx))
                    .unwrap();
                pump(cx, handle, &editor, &updates);
                cx.update_window(handle, |_, w, cx| {
                    if mode == ThemeMode::Light {
                        w.click("new-project-project-ab", cx);
                    } else {
                        w.press("down", cx);
                        w.press("enter", cx);
                    }
                })
                .unwrap();
                pump(cx, handle, &editor, &updates);
                // Capture a nonempty native message BEFORE transient catalog failure.
                cx.update_window(handle, |_, w, cx| {
                    let input = editor.read(cx).text.clone();
                    input.update(cx, |t, cx| t.focus(w, cx));
                    w.input("Project chosen 日本語 👩‍💻", cx);
                })
                .unwrap();
                pump(cx, handle, &editor, &updates);
                let (key, before) = cx.update(|cx| {
                    (
                        editor.read(cx).navigation_key().unwrap().to_owned(),
                        editor.read(cx).draft().unwrap().clone(),
                    )
                });
                cx.update_window(handle, |_, w, cx| {
                    editor.update(cx, |e, cx| {
                        assert_eq!(e.draft().unwrap().project_id.as_deref(), Some("project-ab"));
                        assert_eq!(e.draft().unwrap().cwd, "/synthetic/shared");
                        e.projects(
                            Arc::new(local_model::projects(&catalog()).unwrap()),
                            mode != ThemeMode::Dark,
                            (mode == ThemeMode::Light).then_some("Synthetic unavailable"),
                            w,
                            cx,
                        );
                        e.text.update(cx, |t, cx| t.focus(w, cx));
                    });
                    w.press("enter", cx); // Must not reserve or post during loading/error.
                })
                .unwrap();
                pump(cx, handle, &editor, &updates);
                assert!(server.seen.lock().unwrap().envelopes.is_empty());
                cx.update_window(handle, |_, w, cx| {
                    assert!(w.try_find("new-chat-project").is_none());
                    assert_eq!(w.find("local-send").disabled(), Some(true));
                    editor.update(cx, |e, cx| {
                        assert!(e.state.book.as_ref().unwrap().pending.is_empty());
                        assert!(e.draft().unwrap() == &before);
                        e.projects(
                            Arc::new(local_model::projects(&catalog()).unwrap()),
                            true,
                            None,
                            w,
                            cx,
                        );
                    });
                })
                .unwrap();
                pump(cx, handle, &editor, &updates);
                // Reselect the SAME ID/path using the actual native picker, with no edit.
                cx.update_window(handle, |_, w, cx| focus_project_search(&editor, w, cx))
                    .unwrap();
                pump(cx, handle, &editor, &updates);
                cx.update_window(handle, |_, w, cx| w.input("project-ab", cx))
                    .unwrap();
                pump(cx, handle, &editor, &updates);
                cx.update_window(handle, |_, w, cx| {
                    if mode == ThemeMode::Light {
                        w.click("new-project-project-ab", cx);
                    } else {
                        w.press("down", cx);
                        w.press("enter", cx);
                    }
                })
                .unwrap();
                pump(cx, handle, &editor, &updates);
                cx.update_window(handle,|_,w,cx| {
                    assert_eq!(editor.read(cx).navigation_key(),Some(key.as_str()));
                    assert!(editor.read(cx).draft().unwrap()==&before);
                    assert!(editor.read(cx).state.book.as_ref().unwrap().pending.is_empty());
                    assert_ne!(w.find("local-send").disabled(),Some(true),"healthy catalog plus same-choice reselection must recover without a message edit");
                }).unwrap();
                assert!(
                    server.seen.lock().unwrap().envelopes.is_empty(),
                    "recovery never auto-submits"
                );
                capture(
                    cx,
                    handle,
                    &dir,
                    format!("{}-{}-{}-selected.png", width as u32, mode.name(), lost),
                );
                cx.update_window(handle, |_, w, cx| {
                    let input = editor.read(cx).text.clone();
                    input.update(cx, |t, cx| t.focus(w, cx));
                    w.press("enter", cx);
                    w.press("enter", cx);
                    w.click("local-send", cx);
                })
                .unwrap();
                until(cx, handle, &editor, &updates, |e| {
                    if lost {
                        e.draft().is_some_and(|d| d.pending.is_some())
                            && server.seen.lock().unwrap().envelopes.len() == 1
                            // Receiving the request is not completion of the lost-ACK path.
                            // Resolve mounts only after the courier publishes its result.
                            && !e.pending.contains_key(e.selected.as_ref().unwrap())
                    } else {
                        e.draft().is_some_and(|d| d.created.is_some())
                    }
                });
                let operation = server.seen.lock().unwrap().envelopes[0].clone();
                if lost {
                    cx.update_window(handle, |_, w, _| {
                        // A sent draft's destination is fixed: no project rows to click.
                        assert!(w.try_find("new-chat-project").is_none());
                    })
                    .unwrap();
                    pump(cx, handle, &editor, &updates);
                    assert_eq!(server.seen.lock().unwrap().envelopes.len(), 1);
                    cx.update_window(handle, |_, w, cx| w.click("composer-recovery", cx))
                        .unwrap();
                    pump(cx, handle, &editor, &updates);
                    cx.update_window(handle, |_, w, cx| w.click("check-delivery", cx))
                        .unwrap();
                    until(cx, handle, &editor, &updates, |e| {
                        e.draft().is_some_and(|d| d.created.is_some())
                    });
                }
                let target =
                    cx.update(|cx| editor.read(cx).draft().unwrap().created.clone().unwrap());
                assert_eq!(server.readback(&target)["projectId"], "project-ab");
                assert_eq!(operation["targetId"], target);
                assert_eq!(server.seen.lock().unwrap().envelopes.len(), 1);
                capture(
                    cx,
                    handle,
                    &dir,
                    format!("{}-{}-{}-accepted.png", width as u32, mode.name(), lost),
                );
                close(cx, handle, writer, &updates);
                drop(editor);
                // Restart/readback is private-state only: never sends a second create.
                let store =
                    crate::delivery_store::Store::open(private.0.clone(), server.options.host())
                        .unwrap();
                assert_eq!(
                    store.book.drafts[&key].project_id.as_deref(),
                    Some("project-ab")
                );
                assert_eq!(
                    store.book.drafts[&key].created.as_deref(),
                    Some(target.as_str())
                );
                drop(store);
                assert_eq!(server.seen.lock().unwrap().envelopes.len(), 1);
                println!(
                    "{}",
                    json!({"width":width,"mode":mode.name(),"lost_after_admission":lost,"actual_native_composer":true,"actual_pointer_or_keyboard_project_choice":true,"catalog_recovered_after_enter_without_edit":true,"same_path_distinct_id":true,"payload_project_id":"project-ab","cwd_override":false,"canonical_faux_readback":true,"private_restart_selection":true,"create_posts":1})
                );
            }
        }
    }
}
