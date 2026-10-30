//! Recent authoritative page, real hidden mount/scroll and live prepend. No Local connection.
use super::*;

pub(super) fn run(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
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
            let context = json!({"conversationId":0,"tail":6000});
            let entry = |id| json!({"id":id,"kind":"pi.user","model":[{"role":"user","content":format!("Synthetic 日本 message {id}. {}","Exact retained source. ".repeat(20))}]});
            let mut model = crate::local_model::LiveTranscript::default();
            let projection = std::time::Instant::now();
            model.apply(&json!({"type":"snapshot","entries":(5941..=6000).map(entry).collect::<Vec<_>>(),"history":{"context":context,"more":true,"before":5941,"question":null}}));
            let initial = model.rows();
            let projection = projection.elapsed();
            assert_eq!(initial.len(), 60);
            assert!(model.loaded);
            let (client, commands) = LocalClient::synthetic_commands();
            let mount = std::time::Instant::now();
            let (handle, view) = cx.update(|cx| {
                gpui_kit::open_window(
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
                        cx.new(|cx| {
                            let mut v = LocalViewer::preview(PreviewState::Conversation, w, cx);
                            v.client = Some(client);
                            v.selected = Some("paged-fixture".into());
                            v.generation = 10;
                            v.state.generation = 10;
                            v.state.loaded = true;
                            v.state.cursor = model.cursor;
                            v.state.rows = initial.clone();
                            v.transcript.update(cx, |t, cx| {
                                t.history_scope(10);
                                t.replace_readonly(initial, true, cx);
                            });
                            v.sync_history_controls(cx);
                            v
                        })
                    },
                )
                .unwrap()
            });
            cx.update_window(handle, |_, w, cx| w.render_frame(cx))
                .unwrap();
            let first_frame = mount.elapsed();
            settle(cx, handle);
            assert!(cx.update(|cx| view.read(cx).text_parsers_ready(cx)));
            assert!(
                commands.try_recv().is_err(),
                "mount never fetches the remaining 5940 entries"
            );
            up(cx, handle, &view);
            settle(cx, handle);
            assert!(matches!(
                commands.try_recv(),
                Ok(Command::Earlier {
                    before: 5941,
                    generation: 10
                })
            ));
            model.apply(&json!({"type":"entry_appended","entry":entry(6001)}));
            page(cx, handle, &view, model.rows(), model.cursor, 0);
            assert!(
                cx.update(|cx| view.read(cx).state.page_busy),
                "live publication is not page completion"
            );
            cx.update_window(handle, |_, w, cx| {
                view.update(cx, |v, cx| {
                    let mut state = v.state.clone();
                    state.rows = v.transcript.read(cx).link_snapshot_rows();
                    state.page_busy = false;
                    state.page_error = true;
                    state.page_revision += 1;
                    v.accept(state, w, cx);
                })
            })
            .unwrap();
            settle(cx, handle);
            assert!(
                !cx.update(|cx| view
                    .read(cx)
                    .transcript
                    .read(cx)
                    .link_snapshot_rows()
                    .is_empty()),
                "page failure retains readable content"
            );
            up(cx, handle, &view);
            settle(cx, handle);
            assert!(
                commands.try_recv().is_err(),
                "failed page cannot retry on overscroll"
            );
            if let Some(dir) = std::env::var_os("PILOT_NEXT_HISTORY_DIR") {
                let dir = std::path::PathBuf::from(dir);
                std::fs::create_dir_all(&dir).unwrap();
                cx.capture_screenshot(handle)
                    .unwrap()
                    .save(dir.join(format!("paged-error-{}-{}.png", width as u32, mode.name())))
                    .unwrap();
            }
            cx.update_window(handle, |_, w, cx| w.click("history-retry", cx))
                .unwrap();
            settle(cx, handle);
            assert!(matches!(
                commands.try_recv(),
                Ok(Command::Earlier {
                    before: 5941,
                    generation: 10
                })
            ));
            assert!(model.page(5941,&json!({"context":context,"before":5941,"entries":(5917..5941).map(entry).collect::<Vec<_>>(),"more":true,"nextBefore":5917})));
            page(cx, handle, &view, model.rows(), model.cursor, 2);
            assert!(!cx.update(|cx| view.read(cx).state.page_busy));
            assert!(
                commands.try_recv().is_err(),
                "prepend does not eagerly chain pages"
            );
            if let Some(dir) = std::env::var_os("PILOT_NEXT_HISTORY_DIR") {
                let dir = std::path::PathBuf::from(dir);
                std::fs::create_dir_all(&dir).unwrap();
                cx.capture_screenshot(handle)
                    .unwrap()
                    .save(dir.join(format!("paged-{}-{}.png", width as u32, mode.name())))
                    .unwrap();
            }
            println!(
                "paged hidden {width} {}: 60-row reducer={projection:?}; mount+first CPU frame={first_frame:?}; not network/GPU/visible latency",
                mode.name()
            );
            cx.update_window(handle, |_, w, _| w.remove_window())
                .unwrap();
            cx.run_until_parked();
        }
    }
}
