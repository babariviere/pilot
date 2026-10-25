//! One startup owner, one result, then the ordinary Local view. No alternate client/settings state.
use crate::{
    LocalOptions, LocalViewer, bundled_runtime,
    ui::{self, Notice, Text, Tone},
};
use gpui_kit::component::{ActiveTheme, StyledExt};
use gpui_kit::{
    AppContext, Context, Entity, InteractiveElement, IntoElement, ParentElement, Render, Styled,
    Task, TestSupportExt, Window,
};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

pub struct BundledRuntimeView {
    local: Option<Entity<LocalViewer>>,
    error: Option<&'static str>,
    cancel: Arc<AtomicBool>,
    _updates: Task<()>,
    _closed: gpui_kit::Subscription,
}
impl Drop for BundledRuntimeView {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}
impl BundledRuntimeView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let cancel = Arc::new(AtomicBool::new(false));
        let (send, result) = async_channel::bounded(1);
        let worker_cancel = cancel.clone();
        let started = std::thread::Builder::new()
            .name("bundled-runtime-startup".into())
            .spawn(move || {
                let reply = std::env::current_exe()
                    .map_err(|_| "Cannot locate this app executable.")
                    .and_then(|executable| bundled_runtime::start(executable, worker_cancel));
                let _ = send.send_blocking(reply);
            });
        let error = started
            .err()
            .map(|_| "Cannot start the bundled runtime worker.");
        Self::listening(window, cx, result, error, cancel, LocalViewer::new)
    }
    fn listening(
        window: &mut Window,
        cx: &mut Context<Self>,
        result: async_channel::Receiver<Result<LocalOptions, &'static str>>,
        error: Option<&'static str>,
        cancel: Arc<AtomicBool>,
        make_local: fn(LocalOptions, &mut Window, &mut Context<LocalViewer>) -> LocalViewer,
    ) -> Self {
        // The native window can close before retained frames/entities are collected.
        // Cancel immediately at the actual close boundary, with Drop as a fallback.
        let window_id = window.window_handle().window_id();
        let close_cancel = cancel.clone();
        let closed = cx.on_window_closed(move |_, id| {
            if id == window_id {
                close_cancel.store(true, Ordering::Relaxed);
            }
        });
        let updates = cx.spawn_in(window, async move |view, cx| {
            let reply = result.recv().await.unwrap_or(Err("Local startup worker stopped before reporting. An activated daemon may still be running; it was not stopped."));
                let _ = view.update_in(cx, |view, window, cx| {
                    match reply {
                        Ok(options) => {
                            window.set_window_title("Pilot Next · Local");
                            view.local = Some(cx.new(|cx| make_local(options, window, cx)));
                        }
                        Err(error) => { view.error.get_or_insert(error); },
                    }
                    cx.notify();
                });
        });
        Self {
            local: None,
            error,
            cancel,
            _updates: updates,
            _closed: closed,
        }
    }
}
impl Render for BundledRuntimeView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(local) = &self.local {
            return local.clone().into_any_element();
        }
        let content = ui::page()
            .child(ui::heading("runtime-title", "Pilot Next", Text::Title))
            .child(gpui_kit::div().id("runtime-status").test_support().child(Notice::new(self.error.unwrap_or("Starting Local…")).tone(if self.error.is_some() { Tone::Error } else { Tone::Quiet })))
            .child(ui::text(Text::Caption, "Existing work and drafts stay with their Local profile. No existing daemon is stopped or replaced.").id("runtime-detail").test_support())
            .child(ui::action("runtime-close", "Close", ui::Action::Quiet).on_click(|_, _, cx| cx.quit()));
        ui::surface(ui::Surface::Page, cx)
            .id("runtime-startup-root")
            .test_support()
            .text_color(cx.theme().foreground)
            .size_full()
            .v_flex()
            .justify_center()
            .child(content)
            .into_any_element()
    }
}

#[cfg(feature = "native-probes")]
impl BundledRuntimeView {
    /// Native production-view probe with an injected result lane and memory-only Local fixture.
    /// Never starts the startup worker, discovers Local, or reads/writes user state.
    pub fn run_probe(cx: &mut gpui_kit::HeadlessAppContext) {
        use gpui_kit::{
            AnyWindowHandle, Bounds, HeadlessAppContext, WindowBounds, WindowOptions, px, size,
            test::TestWindowExt,
        };
        use std::{path::PathBuf, time::Duration};
        fn settle(cx: &mut HeadlessAppContext, handle: AnyWindowHandle) {
            for _ in 0..4 {
                cx.run_until_parked();
                cx.advance_clock(Duration::from_millis(16));
                cx.update_window(handle, |_, window, cx| window.render_frame(cx))
                    .unwrap();
            }
        }
        let output = std::env::var_os("PILOT_NEXT_RUNTIME_DIR").map(PathBuf::from);
        if let Some(output) = &output {
            std::fs::create_dir_all(output).unwrap();
        }
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
                let (send, updates) = async_channel::bounded(1);
                let cancel = Arc::new(AtomicBool::new(false));
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
                        |window, cx| {
                            cx.new(|cx| {
                                Self::listening(
                                    window,
                                    cx,
                                    updates,
                                    None,
                                    cancel.clone(),
                                    |_, window, cx| LocalViewer::synthetic(window, cx),
                                )
                            })
                        },
                    )
                    .unwrap()
                });
                settle(cx, handle);
                cx.update(|cx| {
                    assert_eq!(cx.theme().is_dark(), dark);
                    assert!(view.read(cx).error.is_none());
                    assert!(view.read(cx).local.is_none());
                });
                for state in ["loading", "unconfirmed"] {
                    if state == "unconfirmed" {
                        send.send_blocking(Err("Local startup is unconfirmed. An activated daemon may still be starting. It was left running to preserve work.")).unwrap();
                        settle(cx, handle);
                        cx.update(|cx| {
                            assert!(view.read(cx).error.unwrap().contains("unconfirmed"));
                            assert!(view.read(cx).local.is_none());
                        });
                    }
                    cx.update_window(handle, |_, window, _| {
                        let root = window.find("runtime-startup-root").bounds();
                        assert_eq!(root.size.width, px(width));
                        for id in [
                            "runtime-title",
                            "runtime-status",
                            "runtime-detail",
                            "runtime-close",
                        ] {
                            let bounds = window.find(id).bounds();
                            assert!(
                                bounds.left() >= root.left()
                                    && bounds.right() <= root.right()
                                    && bounds.top() >= root.top()
                                    && bounds.bottom() <= root.bottom(),
                                "{id} stays readable inside startup window"
                            );
                        }
                        assert_ne!(window.find("runtime-close").disabled(), Some(true));
                    })
                    .unwrap();
                    if let Some(output) = &output {
                        cx.capture_screenshot(handle)
                            .unwrap()
                            .save(output.join(format!(
                                "{}-{}-{state}.png",
                                width as u32,
                                if dark { "dark" } else { "light" }
                            )))
                            .unwrap();
                    }
                }
                cx.update_window(handle, |_, window, _| window.remove_window())
                    .unwrap();
                drop(view);
                assert!(cx.update_window(handle, |_, _, _| {}).is_err());
                cx.run_until_parked();
                assert!(
                    cancel.load(Ordering::Relaxed),
                    "closed view cancels its owned startup lane"
                );
                assert!(send.is_closed(), "late results cannot update a closed view");
                println!(
                    "startup native width={width} dark={dark}: loading/unconfirmed bounds, close availability and cancellation passed"
                );
            }
        }
        // A worker that disappears must become an honest error rather than an eternal loading view.
        let (send, updates) = async_channel::bounded(1);
        let (handle, view) = cx.update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    show: false,
                    ..Default::default()
                },
                cx,
                |window, cx| {
                    cx.new(|cx| {
                        Self::listening(
                            window,
                            cx,
                            updates,
                            None,
                            Arc::new(AtomicBool::new(false)),
                            |_, window, cx| LocalViewer::synthetic(window, cx),
                        )
                    })
                },
            )
            .unwrap()
        });
        drop(send);
        settle(cx, handle);
        cx.update(|cx| {
            assert!(
                view.read(cx)
                    .error
                    .unwrap()
                    .contains("stopped before reporting")
            )
        });
        cx.update_window(handle, |_, window, _| window.remove_window())
            .unwrap();
        drop(view);
        // Successful delivery uses the existing Local view, with a network-/disk-free fixture factory.
        let (send, updates) = async_channel::bounded(1);
        let (handle, view) = cx.update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    show: false,
                    ..Default::default()
                },
                cx,
                |window, cx| {
                    cx.new(|cx| {
                        Self::listening(
                            window,
                            cx,
                            updates,
                            None,
                            Arc::new(AtomicBool::new(false)),
                            |_, window, cx| LocalViewer::synthetic(window, cx),
                        )
                    })
                },
            )
            .unwrap()
        });
        send.send_blocking(Ok(LocalOptions::synthetic(1))).unwrap();
        settle(cx, handle);
        cx.update(|cx| assert!(view.read(cx).local.is_some()));
        cx.update_window(handle, |_, window, _| window.remove_window())
            .unwrap();
        drop(view);
    }
}
