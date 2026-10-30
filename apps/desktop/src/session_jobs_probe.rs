//! Mounted production jobs strip + composer with a synthetic Local only.
//! Stop requests reach an owned fixture server, never a real daemon or job.
use super::*;
use gpui_kit::{
    AnyWindowHandle, Bounds, EntityInputHandler, Focusable, HeadlessAppContext, WindowBounds,
    WindowOptions, point, size, test::TestWindowExt,
};
use serde_json::{Value, json};

fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    // Retarget dialog Presence before advancing its theme transition.
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| w.draw(cx).clear(cx))
        .unwrap();
    let duration = cx.update(|cx| cx.theme().motion_tokens().duration_normal);
    cx.advance_clock(duration);
    for _ in 0..6 {
        cx.run_until_parked();
        cx.advance_clock(Duration::from_millis(16));
        cx.update_window(h, |_, w, cx| w.draw(cx).clear(cx))
            .unwrap();
    }
}
/// Waits for the off-UI stop worker's reply to reach the strip.
fn settle_until(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    done: impl Fn(&mut Window) -> bool,
) {
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    loop {
        settle(cx, h);
        if cx.update_window(h, |_, w, _| done(w)).unwrap() {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "bounded synthetic stop"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn logs() -> std::path::PathBuf {
    let dir = std::env::temp_dir()
        .canonicalize()
        .unwrap()
        .join(format!("pilot-job-logs-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    dir
}
fn job(id: &str, name: &str, age_ms: i64, logs: Option<&std::path::Path>) -> Value {
    let mut job = json!({"id":id,"name":name,"state":"running","startedAt":crate::session_jobs::now() - age_ms});
    if let Some(dir) = logs {
        job["outputPath"] = json!(dir.join(format!("{id}.log")));
    }
    job
}
fn rows() -> Vec<Message> {
    (1..=30)
        .map(|id| {
            Message::live(
                id,
                "assistant".into(),
                format!("Reader {id}\n\n{}", "Retained conversation. ".repeat(30)),
            )
            .anchored(crate::model::ReaderKey::model(id, 0, Some(0)))
        })
        .collect()
}
/// One sessions-list publication, as LocalClient sends on every summary change.
fn publish(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    view: &Entity<LocalViewer>,
    jobs: Value,
    connected: bool,
) {
    cx.update_window(h, |_, w, cx| {
        view.update(cx, |v, cx| {
            let mut state = v.state.clone();
            state.rows = rows();
            state.status = if connected {
                "Connected · Local".into()
            } else {
                "Local disconnected. Reconnecting with identity validation…".into()
            };
            state.list_loaded = true;
            let chats = Arc::make_mut(&mut state.chats);
            let index = chats.iter().position(|c| c.id == "source").unwrap();
            chats[index] = crate::local_model::chat(&json!({"id":"source","title":"Source","cwd":"/synthetic/project","state":"idle","working":!jobs.as_array().unwrap().is_empty(),"runningJobs":jobs})).unwrap();
            v.accept(state, w, cx);
        })
    })
    .unwrap();
    settle(cx, h);
}
fn assert_hidden(w: &mut Window) {
    for id in [
        "session-jobs-strip",
        "session-jobs-toggle",
        "session-jobs-list",
    ] {
        assert!(w.try_find(id).is_none(), "no jobs mounted {id}");
    }
    assert_eq!(
        w.find("conversation-editor").bounds().size.height,
        px(76. + 6.) + w.rem_size() * 0.75,
        "hidden strip leaves no gap"
    );
    assert_eq!(w.find("composer-tray").bounds().size.height, px(76.));
    assert_eq!(w.find("composer-input").bounds().size.height, px(34.));
}
fn label(w: &mut Window) -> String {
    w.find("session-jobs-toggle").label().unwrap().to_string()
}

pub fn run_session_jobs_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_JOBS_DIR").map(std::path::PathBuf::from);
    if let Some(p) = &captures {
        std::fs::create_dir_all(p).unwrap();
    }
    let capture = |cx: &mut HeadlessAppContext, h: AnyWindowHandle, name: &str| {
        if let Some(p) = &captures {
            cx.capture_screenshot(h)
                .unwrap()
                .save(p.join(format!("{name}.png")))
                .unwrap();
        }
    };
    for width in [680., 1100.] {
        for dark in [false, true] {
            cx.update(|cx| {
                crate::appearance::commit_appearance(
                    if dark {
                        crate::settings_state::AppearancePreference::Dark
                    } else {
                        crate::settings_state::AppearancePreference::Light
                    },
                    cx,
                )
            });
            let tag = format!("{width}-{}", if dark { "dark" } else { "light" });
            let dir = logs();
            std::fs::write(
                dir.join("long.log"),
                "\u{1b}[32mCompiling\u{1b}[0m 日本 👩‍💻\nstep 1/2\rstep 2/2\n",
            )
            .unwrap();
            let server = crate::session_jobs_fixture::Server::start(202);
            let (writer, writes) = Interaction::recording();
            let (client, commands) = LocalClient::synthetic_commands();
            let (h, view) = cx
                .update(|cx| {
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(840.)),
                            ))),
                            show: false,
                            focus: false,
                            ..Default::default()
                        },
                        cx,
                        |w, cx| {
                            cx.new(|cx| {
                                let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                                v.client = Some(client);
                                v.usage_options = Some(server.options.clone());
                                let chat = crate::local_model::chat(&json!({"id":"source","title":"Source","cwd":"/synthetic/project","state":"idle"})).unwrap();
                                let other = v.state.chats[1].clone();
                                v.state.chats = Arc::new(vec![chat, other]);
                                v.state.status = "Connected · Local".into();
                                v.state.list_loaded = true;
                                v.selected = Some("source".into());
                                v.editor.update(cx, |e, cx| e.shell_probe_setup(writer, w, cx));
                                v.editor.update(cx, |e, cx| {
                                    e.select("chat:source".into(), true, false, w, cx)
                                });
                                v.state.rows = rows();
                                v.transcript.update(cx, |t, cx| {
                                    t.replace_readonly(v.state.rows.clone(), true, cx)
                                });
                                v
                            })
                        },
                    )
                })
                .unwrap();
            settle(cx, h);
            let (editor, transcript) = cx.update(|cx| {
                (
                    view.read(cx).editor.clone(),
                    view.read(cx).transcript.clone(),
                )
            });
            let input = cx.update(|cx| editor.read(cx).shell_probe().0);
            let draft = "Unsent 私 👩‍💻 draft";
            cx.update_window(h, |_, w, cx| {
                assert_hidden(w);
                input.update(cx, |i, cx| i.focus(w, cx));
                w.input(draft, cx);
                w.scroll(
                    "viewport",
                    gpui_kit::ScrollDelta::Pixels(point(px(0.), px(100000.))),
                    cx,
                );
            })
            .unwrap();
            settle(cx, h);
            let send = cx
                .update_window(h, |_, w, _| w.find("local-send").bounds())
                .unwrap();
            let anchor = cx.update(|cx| transcript.read(cx).history_probe_anchor(cx));
            assert!(!anchor.2, "fixture must really be reading history");
            // Zero jobs: nothing mounted, no reserved space.
            publish(cx, h, &view, json!([]), true);
            cx.update_window(h, |_, w, _| assert_hidden(w)).unwrap();
            capture(cx, h, &format!("jobs-none-{tag}"));

            // One job: concise identity and elapsed time, collapsed, no focus change.
            publish(
                cx,
                h,
                &view,
                json!([job("tests", "cargo test --workspace", 245_000, Some(&dir))]),
                true,
            );
            cx.update_window(h, |_, w, cx| {
                assert!(
                    label(w).starts_with(
                        "Show 1 job running. Running: cargo test --workspace, for 4 minutes"
                    ),
                    "{}",
                    label(w)
                );
                assert!(w.find("session-jobs-name").visible());
                assert!(
                    w.try_find("session-jobs-list").is_none(),
                    "updates never auto-open"
                );
                let strip = w.find("session-jobs-strip").bounds();
                let tray = w.find("composer-tray").bounds();
                assert!(strip.bottom() <= tray.top() && strip.right() <= tray.right());
                assert_eq!(tray.size.height, px(76.));
                assert_eq!(w.find("composer-input").bounds().size.height, px(34.));
                let now = w.find("local-send").bounds();
                assert_eq!(
                    (now.size, now.left(), now.bottom()),
                    (send.size, send.left(), send.bottom())
                );
                assert_eq!(input.read(cx).value().as_ref(), draft);
                assert!(
                    input.focus_handle(cx).is_focused(w),
                    "updates never steal focus"
                );
                assert!(
                    w.try_find("activity-indicator").is_none(),
                    "the strip replaces Working... for job-only work"
                );
                let now = transcript.read(cx).history_probe_anchor(cx);
                assert_eq!(now.0, anchor.0);
                assert!((now.1 - anchor.1).abs() < 1.);
            })
            .unwrap();
            capture(cx, h, &format!("jobs-one-{tag}"));

            // Several jobs, with a long Unicode name and one without a log path.
            let long = "Build 日本語 👩‍💻 release artifacts for every platform ".repeat(6);
            let three = json!([
                job("tests", "cargo test --workspace", 245_000, Some(&dir)),
                job("long", &long, 3_900_000, Some(&dir)),
                job("quick", "lint", 12_000, None),
            ]);
            publish(cx, h, &view, three.clone(), true);
            cx.update_window(h, |_, w, cx| {
                let text = label(w);
                assert!(
                    text.starts_with("Show 3 jobs running. Longest: Build 日本語"),
                    "{text}"
                );
                assert!(text.ends_with("for 1 hour 5 minutes"), "{text}");
                let strip = w.find("session-jobs-strip").bounds();
                assert!(w.find("session-jobs-name").bounds().right() <= strip.right());
                w.click("session-jobs-toggle", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    input.focus_handle(cx).is_focused(w),
                    "pointer disclosure keeps composer focus"
                );
                assert!(label(w).starts_with("Hide 3 jobs running"));
                let list = w.find("session-jobs-list").bounds();
                assert!(list.size.height <= px(168.));
                let strip = w.find("session-jobs-strip").bounds();
                assert!(strip.bottom() <= w.find("composer-tray").bounds().top());
                // Two-line rows grow; a row without a log path stays one line.
                let (tests, quick) = (
                    w.find("session-job:tests").bounds(),
                    w.find("session-job:quick").bounds(),
                );
                assert!(tests.size.height > quick.size.height, "{tests:?} {quick:?}");
                assert!(quick.size.height >= px(28.));
                assert!(w.find("session-job-path:tests").visible());
                let (count, name) = (
                    w.find("session-jobs-count").bounds(),
                    w.find("session-job-name:tests").bounds(),
                );
                assert!(
                    (count.left() - name.left()).abs() <= px(1.5),
                    "rows align under the summary label: {count:?} {name:?}"
                );
                assert!(w.try_find("session-job-path:quick").is_none());
                assert!(
                    w.try_find("session-job-log:quick").is_none(),
                    "no log without a path"
                );
                assert!(
                    w.find("session-job-name:long").bounds().right()
                        <= w.find("session-job-elapsed:long").bounds().left()
                );
                assert!(w.find("session-job-stop:long").bounds().right() <= strip.right());
                assert_eq!(w.find("composer-tray").bounds().size.height, px(76.));
                let now = w.find("local-send").bounds();
                assert_eq!(
                    (now.size, now.left(), now.bottom()),
                    (send.size, send.left(), send.bottom())
                );
            })
            .unwrap();
            capture(cx, h, &format!("jobs-expanded-{tag}"));

            // Live log: the popup tails the reported file and follows new output.
            cx.update_window(h, |_, w, cx| w.click("session-job-log:long", cx))
                .unwrap();
            settle_until(cx, h, |w| w.try_find("job-log-line:1").is_some());
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("job-log-path").visible());
                assert!(
                    w.try_find("job-log-line:2").is_none(),
                    "CR overwrote the progress line"
                );
                assert!(w.try_find("job-log-status").is_none());
                w.click("job-log-copy", cx);
                assert_eq!(
                    cx.read_from_clipboard().and_then(|c| c.text()).as_deref(),
                    Some("Compiling 日本 👩‍💻\nstep 2/2"),
                    "copy is the cleaned text"
                );
            })
            .unwrap();
            {
                use std::io::Write;
                let mut file = std::fs::OpenOptions::new()
                    .append(true)
                    .open(dir.join("long.log"))
                    .unwrap();
                for n in 0..200 {
                    writeln!(file, "appended line {n}").unwrap();
                }
            }
            settle_until(cx, h, |w| {
                w.try_find("job-log-line:201").is_some_and(|l| l.visible())
            });
            capture(cx, h, &format!("jobs-log-{tag}"));
            // The job ends while its log is open: the output stays and says so.
            publish(
                cx,
                h,
                &view,
                json!([three[0].clone(), three[2].clone()]),
                true,
            );
            cx.update_window(h, |_, w, _| {
                assert!(w.find("job-log-status").visible());
                assert!(w.find("job-log-line:201").visible());
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| w.click("job-log-done", cx))
                .unwrap();
            settle(cx, h);
            publish(cx, h, &view, three.clone(), true);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("job-log").is_none(), "Done closes the popup");
                assert_eq!(input.read(cx).value().as_ref(), draft);
                assert!(w.find("session-jobs-list").visible());
            })
            .unwrap();

            // Stop: one POST for the exact job, Stopping… until the summary drops it.
            cx.update_window(h, |_, w, cx| w.click("session-job-stop:tests", cx))
                .unwrap();
            settle_until(cx, h, |w| {
                w.try_find("session-job-stopping:tests").is_some()
            });
            settle(cx, h);
            assert_eq!(server.stops(), ["/api/sessions/source/jobs/tests/stop"]);
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("session-job-stopping:tests").visible());
                assert_eq!(w.find("session-job-stop:tests").disabled(), Some(true));
                w.click("session-job-stop:tests", cx);
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(server.stops().len(), 1, "a pending Stop is not repeated");
            // The worker ended it (cancel/completion/failure look alike: the row goes).
            publish(
                cx,
                h,
                &view,
                json!([three[1].clone(), three[2].clone()]),
                true,
            );
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("session-job:tests").is_none());
                assert!(label(w).starts_with("Hide 2 jobs running"));
                assert!(input.focus_handle(cx).is_focused(w));
            })
            .unwrap();
            // An unconfirmed Stop says so beside its job and stays retryable by hand.
            *server.code.lock().unwrap() = 500;
            cx.update_window(h, |_, w, cx| w.click("session-job-stop:quick", cx))
                .unwrap();
            settle_until(cx, h, |w| w.try_find("session-job-error:quick").is_some());
            cx.update_window(h, |_, w, _| {
                assert!(w.find("session-job-error:quick").visible());
                assert!(
                    w.find("session-job:quick").bounds().size.height > px(28.),
                    "error line grows the row"
                );
                assert!(w.find("session-job-elapsed:quick").visible());
                assert_ne!(
                    w.find("session-job-stop:quick").disabled(),
                    Some(true),
                    "retry is by hand only"
                );
            })
            .unwrap();
            capture(cx, h, &format!("jobs-error-{tag}"));
            assert_eq!(server.stops().len(), 2);

            // Reconnecting: last reported jobs stay, never called running or stopped.
            publish(
                cx,
                h,
                &view,
                json!([three[1].clone(), three[2].clone()]),
                false,
            );
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("session-jobs-stale").visible());
                assert!(w.find("session-jobs-last-reported").visible());
                assert!(
                    w.try_find("session-job-elapsed:quick").is_none(),
                    "no elapsed time for a stale list"
                );
                assert_eq!(w.find("session-job-stop:long").disabled(), Some(true));
                assert!(label(w).contains("Last reported"));
                w.click("session-job-stop:long", cx);
            })
            .unwrap();
            settle(cx, h);
            assert_eq!(
                server.stops().len(),
                2,
                "no Stop while the list is not current"
            );
            capture(cx, h, &format!("jobs-stale-{tag}"));
            publish(
                cx,
                h,
                &view,
                json!([three[1].clone(), three[2].clone()]),
                true,
            );
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("session-jobs-stale").is_none())
            })
            .unwrap();

            // Keyboard: Shift-Tab from the editor walks back into the strip.
            cx.update_window(h, |_, w, cx| {
                w.click("session-jobs-toggle", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("session-jobs-list").is_none());
                input.update(cx, |i, cx| i.focus(w, cx));
                w.press("shift-tab", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(w.find("session-jobs-strip").focused(), Some(true));
                w.press("space", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.find("session-jobs-list").visible(),
                    "Space opens the list"
                );
                w.press("enter", cx);
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(w.try_find("session-jobs-list").is_none(), "Enter closes it");
                w.press("space", cx);
            })
            .unwrap();
            settle(cx, h);
            // All jobs end while the strip holds focus: it hides, focus returns to the composer.
            publish(cx, h, &view, json!([]), true);
            cx.update_window(h, |_, w, cx| {
                assert_hidden(w);
                assert!(
                    input.focus_handle(cx).is_focused(w),
                    "focus returns to the composer"
                );
                assert_eq!(input.read(cx).value().as_ref(), draft);
            })
            .unwrap();
            // Reappearing jobs keep the chat's open list and do not steal focus.
            publish(cx, h, &view, json!([three[0].clone()]), true);
            cx.update_window(h, |_, w, cx| {
                assert!(w.find("session-jobs-list").visible());
                assert!(input.focus_handle(cx).is_focused(w));
            })
            .unwrap();

            // Marked text: a pointer on the strip cannot end composition or toggle.
            cx.update_window(h, |_, w, cx| {
                input.update(cx, |i, cx| {
                    i.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
                })
            })
            .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| w.click("session-jobs-toggle", cx))
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.find("session-jobs-list").visible(),
                    "preedit fences the disclosure"
                );
                assert!(input.update(cx, |i, cx| i.marked_text_range(w, cx).is_some()));
                let marked = input
                    .update(cx, |i, cx| i.marked_text_range(w, cx))
                    .unwrap();
                input.update(cx, |i, cx| i.replace_text_in_range(Some(marked), "", w, cx));
                let end = input.read(cx).value().encode_utf16().count();
                input.update(cx, |i, cx| {
                    i.replace_text_in_range(Some(0..end), draft, w, cx)
                });
            })
            .unwrap();
            settle(cx, h);

            // Navigation: another chat has no jobs; returning shows the same jobs and intent.
            cx.update_window(h, |_, w, cx| w.click("chat-row-synthetic-two", cx))
                .unwrap();
            settle(cx, h);
            assert!(
                matches!(commands.try_recv(), Ok(Command::Open { id, .. }) if id == "synthetic-two")
            );
            cx.update_window(h, |_, w, _| {
                assert!(w.try_find("session-jobs-strip").is_none())
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| w.click("chat-row-source", cx))
                .unwrap();
            settle(cx, h);
            assert!(matches!(commands.try_recv(), Ok(Command::Open { id, .. }) if id == "source"));
            cx.update_window(h, |_, w, _| {
                assert!(
                    w.find("session-jobs-list").visible(),
                    "navigation keeps jobs and the open list"
                );
                assert!(w.find("session-job:tests").visible());
            })
            .unwrap();

            assert_eq!(server.stops().len(), 2);
            assert!(commands.try_recv().is_err());
            assert!(
                writes.try_recv().is_err(),
                "the strip never sends or saves drafts"
            );
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
            let _ = std::fs::remove_dir_all(&dir);
            println!(
                "session jobs {tag}: 0/1/many, stop/ended/error, stale, keyboard/IME, focus, draft, reader and navigation passed"
            );
        }
    }
}
