//! Native, retained preview. Review is explicit; export never silently refreshes it.
use crate::{
    diagnostics,
    ui::{self, Action, Notice, Text, Tone},
};
use gpui_kit::{
    AppContext, Context, Entity, EntityInputHandler, IntoElement, ParentElement, Render, Styled,
    Task, Window,
    component::{
        Disableable, StyledExt,
        input::{Textarea, TextareaState},
    },
    div,
};

pub(crate) struct Diagnostics {
    preview: fn() -> Result<async_channel::Receiver<diagnostics::Preview>, &'static str>,
    pub(super) editor: Entity<TextareaState>,
    ready: bool,
    busy: bool,
    message: Option<&'static str>,
    failed: bool,
    task: Option<Task<()>>,
}
impl Diagnostics {
    pub(crate) fn new(w: &mut Window, cx: &mut Context<Self>) -> Self {
        let editor = cx.new(|cx| {
            let mut input = TextareaState::new(w, cx)
                .placeholder("Choose Review capture to prepare a local diagnostic preview.")
                .auto_grow(12, 24);
            input.set_submit_on_enter(false, cx);
            input
        });
        Self {
            preview: diagnostics::preview,
            editor,
            ready: false,
            busy: false,
            message: None,
            failed: false,
            task: None,
        }
    }
    pub(crate) fn marked(&self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        self.editor
            .update(cx, |i, cx| i.marked_text_range(w, cx).is_some())
    }
    pub(crate) fn busy(&self) -> bool {
        self.busy
    }
    fn review(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.marked(w, cx) {
            return;
        }
        // Refresh never discards an edited preview. Clear it explicitly first.
        if self.ready {
            return;
        }
        match (self.preview)() {
            Err(error) => {
                self.message = Some(error);
                self.failed = true;
            }
            Ok(reply) => {
                self.busy = true;
                self.message = None;
                self.task = Some(cx.spawn_in(w, async move |this,cx| {
                    let reply = reply.recv().await;
                    let reply = match reply {
                        Ok(preview) => Ok(cx.background_executor().spawn(async move { preview.json() }).await),
                        Err(error) => Err(error),
                    };
                    let _ = this.update_in(cx, |this,w,cx| {
                        this.busy = false;
                        match reply {
                            Ok(json) => {
                                this.editor.update(cx,|i,cx| i.set_value(json,w,cx));
                                this.ready = true; this.failed = false;
                                use gpui_kit::Focusable;
                                this.editor.focus_handle(cx).focus(w,cx);
                            }
                            Err(_) => { this.message=Some("Capture ended before preview completed. No diagnostic data was exported."); this.failed=true; }
                        }
                        cx.notify();
                    });
                }));
            }
        }
        cx.notify();
    }
    fn clear(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.marked(w, cx) {
            return;
        }
        self.editor.update(cx, |i, cx| i.set_value("", w, cx));
        self.ready = false;
        self.message = None;
        self.failed = false;
        cx.notify();
    }
    fn export(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if !self.ready || self.busy || self.marked(w, cx) {
            return;
        }
        let reviewed = self.editor.read(cx).value().to_string();
        if reviewed.len() > diagnostics::PREVIEW_BYTES
            || serde_json::from_str::<serde_json::Value>(&reviewed).is_err()
        {
            self.message =
                Some("Preview must be valid JSON within 512 KiB. Your edits are retained.");
            self.failed = true;
            cx.notify();
            return;
        }
        let picker =
            cx.prompt_for_new_path(&std::env::temp_dir(), Some("pilot-next-diagnostics.json"));
        self.busy = true;
        self.message = None;
        self.task = Some(cx.spawn(async move |this,cx| {
            let result = match picker.await {
                Ok(Ok(Some(path))) => cx.background_executor().spawn(async move { diagnostics::export(&path,&reviewed) }).await.map(|()| true),
                Ok(Ok(None)) => Ok(false),
                _ => Err("The export destination could not be selected. Your preview is retained."),
            };
            let _ = this.update(cx,|this,cx| {
                this.busy = false;
                this.failed = result.is_err();
                this.message = match result { Ok(true)=>Some("Reviewed preview exported locally. Nothing was sent. Share only after inspecting the file."),Ok(false)=>None,Err(error)=>Some(error) };
                cx.notify();
            });
        }));
        cx.notify();
    }
}
impl Render for Diagnostics {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div().v_flex().gap_4()
            .child(ui::header("settings-page-title","Diagnostics",Text::Title))
            .child(ui::text(Text::Body,"Local desktop tracing only. No daemon logs or chat, draft, tool, path, token or HTTP-body content is captured."))
            .child(ui::text(Text::Caption,"Review the JSON below. Remove records or redact values before export. Clearing removes this preview, not retained capture. No automatic sharing or agent actions."))
            .children(self.busy.then(||ui::text(Text::Caption,if self.ready {"Export in progress. Finish destination selection before closing."} else {"Preparing local preview…"})))
            .child(div().h_flex().gap_2()
                .child(ui::action("diagnostics-review","Review capture",Action::Secondary).disabled(self.busy || self.ready).on_click(cx.listener(|v,_,w,cx|v.review(w,cx))))
                .child(ui::action("diagnostics-clear","Clear preview",Action::Quiet).disabled(self.busy || !self.ready).on_click(cx.listener(|v,_,w,cx|v.clear(w,cx))))
                .child(ui::action("diagnostics-export","Export reviewed…",Action::Primary).disabled(self.busy || !self.ready).on_click(cx.listener(|v,_,w,cx|v.export(w,cx)))))
            .child(Textarea::new(&self.editor).accessibility_id("diagnostics-preview").aria_label("Diagnostic preview, editable JSON").readonly(!self.ready || self.busy))
            .children(self.message.map(|m|Notice::new(m).tone(if self.failed {Tone::Error}else{Tone::Normal})))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::{TestAppContext, WindowOptions, test::TestWindowExt};

    #[gpui_kit::test]
    fn diagnostics_native_picker_cancel_exact_export_and_existing_file_error(
        cx: &mut TestAppContext,
    ) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init_appearance(cx);
        });
        let reviewed = "{\"records\":[],\"redacted\":true}";
        let (h, view) = cx.update(|cx| {
            gpui_kit::open_window(WindowOptions::default(), cx, |w, cx| {
                cx.new(|cx| {
                    let mut view = Diagnostics::new(w, cx);
                    view.ready = true;
                    view.editor.update(cx, |i, cx| i.set_value(reviewed, w, cx));
                    view
                })
            })
            .unwrap()
        });
        cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
        cx.update_window(h, |_, w, cx| w.click("diagnostics-export", cx))
            .unwrap();
        assert!(cx.did_prompt_for_new_path());
        cx.simulate_new_path_selection(|_| None);
        cx.run_until_parked();
        assert!(!view.read_with(cx, |v, _| v.busy));
        assert_eq!(
            view.read_with(cx, |v, cx| v.editor.read(cx).value().to_string()),
            reviewed
        );
        let path = std::env::temp_dir().join(format!(
            "diagnostic-picker-synthetic-{}.json",
            uuid::Uuid::new_v4()
        ));
        cx.update_window(h, |_, w, cx| w.click("diagnostics-export", cx))
            .unwrap();
        cx.simulate_new_path_selection(|_| Some(path.clone()));
        cx.run_until_parked();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), reviewed);
        assert!(!view.read_with(cx, |v, _| v.failed));
        cx.update_window(h, |_, w, cx| w.click("diagnostics-export", cx))
            .unwrap();
        cx.simulate_new_path_selection(|_| Some(path.clone()));
        cx.run_until_parked();
        assert!(view.read_with(cx, |v, _| v.failed));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), reviewed);
        std::fs::remove_file(path).unwrap();
    }
}

#[cfg(feature = "native-probes")]
pub(crate) mod probe {
    use super::*;
    use crate::settings_view::{Category, SettingsPreferences, SettingsView};
    use gpui_kit::{
        AnyWindowHandle, Bounds, ClipboardItem, EntityInputHandler, Focusable, HeadlessAppContext,
        WindowBounds, WindowOptions, component::ThemeMode, px, size, test::TestWindowExt,
    };
    use std::{
        path::PathBuf,
        time::{Duration, Instant},
    };
    fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
        for _ in 0..6 {
            cx.run_until_parked();
            cx.advance_clock(Duration::from_millis(16));
            cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
        }
    }
    fn until(cx: &mut HeadlessAppContext, h: AnyWindowHandle, d: &Entity<Diagnostics>) {
        let end = Instant::now() + Duration::from_secs(5);
        while cx.update(|cx| d.read(cx).busy) {
            assert!(Instant::now() < end, "diagnostic reply bounded");
            settle(cx, h);
            std::thread::yield_now();
        }
        settle(cx, h);
    }
    fn synthetic() -> Result<async_channel::Receiver<diagnostics::Preview>, &'static str> {
        let (send, receive) = async_channel::bounded(1);
        send.try_send(diagnostics::Preview::synthetic()).unwrap();
        Ok(receive)
    }
    pub fn run_diagnostics_probe(cx: &mut HeadlessAppContext) {
        let capture = std::env::var_os("PILOT_NEXT_DIAGNOSTICS_DIR").map(PathBuf::from);
        if let Some(dir) = &capture {
            std::fs::create_dir_all(dir).unwrap();
        }
        for width in [680., 1100.] {
            for mode in [ThemeMode::Light, ThemeMode::Dark] {
                cx.update(|cx| gpui_kit::component::Theme::change(mode, None, cx));
                let (h, settings) = cx.update(|cx| {
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(820.)),
                            ))),
                            show: false,
                            focus: false,
                            ..Default::default()
                        },
                        cx,
                        |w, cx| {
                            let owner = cx.new(|_| SettingsPreferences::new(None));
                            cx.new(|cx| SettingsView::new(owner, w, cx))
                        },
                    )
                    .unwrap()
                });
                cx.update_window(h, |_, w, _| w.activate_window()).unwrap();
                settle(cx, h);
                // Real Settings list entry, not a duplicate standalone diagnostics mock.
                cx.update_window(h, |_, w, cx| w.click("settings-diagnostics", cx))
                    .unwrap();
                settle(cx, h);
                let owner = cx.update(|cx| settings.read(cx).preferences.clone());
                let d = cx.update(|cx| {
                    assert_eq!(owner.read(cx).category, Category::Diagnostics);
                    owner.read(cx).diagnostics.clone().unwrap()
                });
                let editor = cx.update(|cx| d.read(cx).editor.clone());
                assert!(
                    !cx.update(|cx| d.read(cx).ready),
                    "opening never captures or exports"
                );
                cx.update_window(h, |_, w, cx| w.click("diagnostics-review", cx))
                    .unwrap();
                settle(cx, h);
                assert!(
                    cx.update(|cx| d.read(cx).failed),
                    "unavailable subscriber is explicit, never guessed logs"
                );
                d.update(cx, |v, _| v.preview = synthetic);
                cx.update_window(h, |_, w, cx| w.click("diagnostics-review", cx))
                    .unwrap();
                until(cx, h, &d);
                cx.update_window(h, |_, w, cx| {
                    assert!(
                        editor.focus_handle(cx).is_focused(w),
                        "review focuses native editor"
                    );
                    assert!(editor.read(cx).value().contains("partial_files"));
                    assert!(editor.read(cx).value().contains("503"));
                    // Simulated marked text blocks destructive preview actions and Settings navigation.
                    editor.update(cx, |i, cx| {
                        i.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
                    });
                    w.click("diagnostics-clear", cx);
                    w.click("settings-appearance", cx);
                    assert!(editor.update(cx, |i, cx| i.marked_text_range(w, cx).is_some()));
                    assert_eq!(owner.read(cx).category, Category::Diagnostics);
                    settings.update(cx, |v, cx| assert!(!v.request_close(w, cx)));
                    editor.update(cx, |i, cx| i.replace_text_in_range(None, "にほん", w, cx));
                    // Clipboard exercises real Unicode editing, not set_value.
                    cx.write_to_clipboard(ClipboardItem::new_string(
                        "{\"records\":[],\"redacted\":\"資料 é 👩‍💻\"}".into(),
                    ));
                    w.press("secondary-a", cx);
                    w.press("secondary-v", cx);
                })
                .unwrap();
                settle(cx, h);
                let reviewed = cx.update(|cx| editor.read(cx).value().to_string());
                assert!(reviewed.contains("資料 é 👩‍💻"));
                assert!(!reviewed.contains("503"));
                if let Some(dir) = &capture {
                    cx.capture_screenshot(h)
                        .unwrap()
                        .save(dir.join(format!("{}-{}-review.png", width as u32, mode.name())))
                        .unwrap();
                }
                // Tab reaches the real export action. Avoid a native platform
                // picker in this headless-rendering harness; the TestAppContext
                // test below covers cancellation and exact exported bytes.
                cx.update_window(h, |_, w, cx| {
                    w.press("shift-tab", cx);
                    assert_eq!(w.find("diagnostics-export").focused(), Some(true));
                })
                .unwrap();
                // Invalid edits report an error without opening a picker or replacing text.
                cx.update_window(h, |_, w, cx| {
                    editor.focus_handle(cx).focus(w, cx);
                    w.press("secondary-a", cx);
                    w.input("{bad", cx);
                    w.click("diagnostics-export", cx);
                })
                .unwrap();
                settle(cx, h);
                assert!(cx.update(|cx| d.read(cx).failed));

                assert_eq!(cx.update(|cx| editor.read(cx).value().to_string()), "{bad");
                cx.update_window(h, |_, w, cx| w.click("diagnostics-clear", cx))
                    .unwrap();
                settle(cx, h);
                assert!(!cx.update(|cx| d.read(cx).ready));
                assert!(cx.update(|cx| editor.read(cx).value().is_empty()));
                cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
                cx.run_until_parked();
                println!(
                    "dogfooding_diagnostics {} {} passed: Settings/native-preview/keyboard/redaction/IME/errors",
                    width,
                    mode.name()
                );
            }
        }
    }
}
