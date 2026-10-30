//! Native adaptation of MonoCode's quiet ToolDiffPreview chip and bounded disclosure.
//! https://github.com/hardbeat920/monocode/blob/26465c620977f3951d0a532a0f7db32c3c179007/src/features/sessions/ui/ToolDiffPreview.tsx
//! Copyright (c) 2026 Nick, MIT, see licenses/MONOCODE.txt. No upstream runtime.
//! Only the existing tool-local argument preview is eligible, never output/Git/files.
use crate::{
    tool_presentation::{Status, Step, Tool},
    transcript_view::TranscriptView,
    ui::{self, Action, Text},
};
use gpui_kit::base::text::{CodeBlock, TextView, TextViewStyle};
use gpui_kit::{
    AnyWindowHandle, App, AppContext, ClipboardItem, Context, Entity, FocusHandle, HighlightStyle,
    Hsla, InteractiveElement, IntoElement, ParentElement, Render, RenderOnce,
    StatefulInteractiveElement, Styled, Subscription, TestSupportExt, WeakEntity, Window,
    component::{
        ActiveTheme, Disableable, Selectable, StyledExt, button::Button, popover::Popover,
        text::TextViewState,
    },
    div,
    prelude::FluentBuilder,
    px,
};
use std::{ops::Range, sync::Arc};

const BYTE_CAP: usize = 6 * 1024;
const LINE_CAP: usize = 80;

type Highlighter = dyn Fn(&CodeBlock) -> Vec<(Range<usize>, HighlightStyle)> + Send + Sync;
struct DiffInk {
    colors: (Hsla, Hsla),
    highlight: Arc<Highlighter>,
}
impl DiffInk {
    fn new(add: Hsla, remove: Hsla) -> Self {
        Self {
            colors: (add, remove),
            highlight: Arc::new(move |block| {
                diff_lines(&block.code())
                    .into_iter()
                    .map(|(range, addition)| {
                        let ink = if addition { add } else { remove };
                        (
                            range,
                            HighlightStyle {
                                color: Some(ink),
                                background_color: Some(ink.opacity(0.08)),
                                ..Default::default()
                            },
                        )
                    })
                    .collect()
            }),
        }
    }
}
// The existing source is a replacement hunk or V4A patch, not necessarily a
// parseable Git diff. Color its literal body lines without changing the source
// or interpreting file headers as additions/deletions.
fn diff_lines(source: &str) -> Vec<(Range<usize>, bool)> {
    let mut body = false;
    let mut offset = 0;
    let mut ranges = Vec::new();
    for line in source.split_inclusive('\n') {
        if line.starts_with("@@")
            || ["*** Update File:", "*** Add File:", "*** Delete File:"]
                .iter()
                .any(|s| line.starts_with(s))
        {
            body = true;
        }
        if body && (line.starts_with('+') || line.starts_with('-')) {
            let end = offset + line.trim_end_matches(['\n', '\r']).len();
            ranges.push((offset..end, line.starts_with('+')));
        }
        offset += line.len();
    }
    ranges
}
fn fenced(source: &str) -> String {
    let run = source.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    let fence = "`".repeat(3.max(run + 1));
    format!(
        "{fence}\n{source}{}{fence}",
        if source.ends_with('\n') { "" } else { "\n" }
    )
}

// Kit's styled Button owns its keyed focus handle. This mounted wrapper is
// a stable restoration target, retaining the normal native button control.
#[derive(IntoElement)]
struct ChipTrigger {
    button: Button,
    focus: FocusHandle,
}
impl Selectable for ChipTrigger {
    fn selected(mut self, selected: bool) -> Self {
        self.button = self.button.selected(selected);
        self
    }
    fn is_selected(&self) -> bool {
        self.button.is_selected()
    }
}
impl RenderOnce for ChipTrigger {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        div()
            .id("tool-diff-trigger-focus")
            .test_support()
            .track_focus(&self.focus)
            .tab_stop(false)
            .rounded(px(crate::appearance::Radius::CONTROL))
            .focus(|s| s.bg(crate::appearance::selected(cx)))
            .child(self.button)
    }
}

#[derive(Clone, PartialEq, Eq)]
struct Source {
    call: String,
    operation: u64,
    paths: Vec<String>,
    status: Status,
    diff: Arc<String>,
    limited: bool,
    write: bool,
}
impl Source {
    fn from_step(step: &Step) -> Option<Self> {
        let Step::Tool(tool) = step else { return None };
        if tool.diff.is_empty() {
            return None;
        }
        Some(Self::from_tool(tool))
    }
    fn from_tool(tool: &Tool) -> Self {
        Self {
            call: tool.id.clone(),
            operation: tool.key,
            paths: tool.preview_paths().to_vec(),
            status: tool.status,
            diff: tool.diff.clone(),
            limited: tool.limited
                || tool.preview_paths().len() >= 16
                || tool.preview_paths().iter().any(|path| path.ends_with('…')),
            write: tool.name == "write",
        }
    }
    fn label(&self) -> String {
        match self.paths.as_slice() {
            [path] => path.rsplit('/').next().unwrap_or(path).to_owned(),
            [] => "Patch".into(),
            _ => "Patch files".into(),
        }
    }
    fn status(&self) -> &'static str {
        match self.status {
            Status::Pending | Status::Running => "Proposed changes · tool pending",
            Status::Done => "Tool completed · argument preview",
            Status::Error => "Attempted changes · tool failed",
            Status::Interrupted => "Attempted changes · completion unknown",
        }
    }
}

fn shown(diff: &str) -> String {
    let line_end = diff
        .match_indices('\n')
        .nth(LINE_CAP - 1)
        .map_or(diff.len(), |(i, _)| i + 1);
    let mut end = line_end.min(BYTE_CAP);
    while !diff.is_char_boundary(end) {
        end -= 1;
    }
    diff[..end].to_owned()
}

pub(crate) struct Preview {
    owner: WeakEntity<TranscriptView>,
    source: Option<Source>,
    generation: u64,
    open: bool,
    trigger: FocusHandle,
    panel: FocusHandle,
    restore: bool,
    text: Option<Entity<TextViewState>>,
    shown: Arc<String>,
    window: Option<AnyWindowHandle>,
    _release: Subscription,
    ink: DiffInk,
}
impl Preview {
    pub(crate) fn new(owner: WeakEntity<TranscriptView>, cx: &mut Context<Self>) -> Self {
        Self {
            owner,
            source: None,
            generation: 0,
            open: false,
            trigger: cx.focus_handle(),
            panel: cx.focus_handle().tab_stop(false),
            restore: false,
            text: None,
            shown: Arc::new(String::new()),
            window: None,
            _release: cx.on_release(|v, cx| v.retire_focus(cx)),
            ink: DiffInk::new(cx.theme().success, cx.theme().danger),
        }
    }
    pub(crate) fn set(&mut self, step: &Step, cx: &mut Context<Self>) {
        let source = Source::from_step(step);
        if source == self.source {
            return;
        }
        if source.is_none() {
            self.retire(cx);
        }
        self.generation += 1;
        // Controlled Popover sync restores focus before removing old content.
        // Output-only streaming retains the same source and open intent.
        self.restore |= self.open;
        self.open = false;
        self.text = None;
        self.shown = Arc::new(source.as_ref().map_or_else(String::new, |s| shown(&s.diff)));
        self.source = source;
        cx.notify();
    }
    fn ready(&self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        self.owner
            .update(cx, |v, cx| v.tool_preview_ready(w, cx))
            .unwrap_or(false)
    }
    pub(crate) fn retire(&mut self, cx: &mut Context<Self>) {
        self.retire_focus(cx);
        cx.notify();
    }
    fn retire_focus(&mut self, cx: &mut App) {
        if !self.open && !self.restore {
            return;
        }
        self.open = false;
        self.restore = false;
        self.generation += 1;
        let panel = self.panel.clone();
        let owner = self.owner.clone();
        if let Some(window) = self.window {
            // Publication/collapse may be inside a window update. Run before
            // the next draw, while its old focus tree is still mounted.
            cx.defer(move |cx| {
                let _ = cx.update_window(window, |_, w, cx| {
                    if panel.contains_focused(w, cx) {
                        let _ = owner.update(cx, |v, cx| v.focus_reader(w, cx));
                    }
                });
            });
        }
    }
    fn close(&mut self, generation: u64, w: &mut Window, cx: &mut Context<Self>) {
        if self.generation != generation || !self.ready(w, cx) {
            return;
        }
        // The chip is still mounted. Do this before Popover unmounts Copy/Close.
        self.trigger.focus(w, cx);
        self.open = false;
        cx.notify();
    }
}
impl Render for Preview {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = (cx.theme().success, cx.theme().danger);
        if self.ink.colors != colors {
            self.ink = DiffInk::new(colors.0, colors.1);
        }
        let highlighter = self.ink.highlight.clone();
        self.window = Some(w.window_handle());
        if std::mem::take(&mut self.restore) && self.panel.contains_focused(w, cx) {
            self.trigger.focus(w, cx);
        }
        let generation = self.generation;
        let owner = cx.entity().downgrade();
        let content_owner = owner.clone();
        let source = self.source.clone();
        let content_source = self.source.clone().filter(|_| self.open);
        let text = self.text.clone();
        let shown = self.shown.clone();
        let panel_focus = self.panel.clone();
        // Retain the controlled trigger through source invalidation so the
        // native popover can restore mounted focus before its content disappears.
        div()
            .id("tool-diff-chip-guard")
            .when(source.is_none(), |this| {
                this.w(px(0.)).h(px(0.)).overflow_hidden()
            })
            .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                if !v.ready(w, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|v, _: &gpui_kit::base::input::Escape, w, cx| {
                cx.stop_propagation();
                v.close(v.generation, w, cx);
            }))
            .capture_action(
                cx.listener(|v, _: &gpui_kit::base::actions::Cancel, w, cx| {
                    cx.stop_propagation();
                    v.close(v.generation, w, cx);
                }),
            )
            .capture_action(cx.listener(|v, _: &gpui_kit::base::input::Enter, w, cx| {
                if v.open || !v.ready(w, cx) {
                    cx.stop_propagation();
                }
            }))
            .child(
                Popover::new("tool-diff-popover")
                    .track_focus(&self.panel)
                    .open(self.open)
                    .overlay_closable(false)
                    .on_open_change(move |open, w, cx| {
                        let _ = owner.update(cx, |v, cx| {
                            if v.generation != generation || !v.ready(w, cx) {
                                return;
                            }
                            if *open && v.source.is_some() {
                                if v.text.is_none() {
                                    let escaped = fenced(&v.shown);
                                    v.text = Some(cx.new(|cx| {
                                        TextViewState::markdown(&escaped, cx).images_enabled(false)
                                    }));
                                }
                                v.open = true;
                            } else {
                                v.close(generation, w, cx);
                            }
                            cx.notify();
                        });
                    })
                    .trigger(ChipTrigger {
                        focus: self.trigger.clone(),
                        button: ui::action(
                            "tool-diff-chip",
                            source
                                .as_ref()
                                .map_or_else(|| "Preview unavailable".into(), |s| s.label()),
                            Action::Quiet,
                        )
                        .max_w(px(170.))
                        .disabled(source.is_none())
                        .accessibility_label(source.as_ref().map_or_else(
                            || "Preview unavailable".into(),
                            |s| format!("Preview tool changes: {}", s.paths.join(", ")),
                        ))
                        .tooltip(
                            "Preview this tool's proposed replacement or patch, not current files",
                        ),
                    })
                    .content(move |_, w, cx| {
                        let Some(source) = &content_source else {
                            return div().into_any_element();
                        };
                        div()
                            .track_focus(&panel_focus)
                            .child(Self::content(
                                source,
                                text.as_ref().map(|text| (text, highlighter.clone())),
                                &shown,
                                content_owner.clone(),
                                generation,
                                w,
                                cx,
                            ))
                            .into_any_element()
                    }),
            )
    }
}
impl Preview {
    fn content(
        source: &Source,
        text: Option<(&Entity<TextViewState>, Arc<Highlighter>)>,
        shown: &str,
        owner: WeakEntity<Self>,
        generation: u64,
        w: &mut Window,
        cx: &mut App,
    ) -> gpui_kit::AnyElement {
        let partial = source.limited || shown.len() != source.diff.len();
        let close_owner = owner.clone();
        let source_label = if source.write {
            "Tool arguments · previous contents unavailable"
        } else {
            "Tool arguments · not filesystem or Git state"
        };
        let mut panel = div()
            .id("tool-diff-preview")
            .test_support()
            .v_flex()
            .gap_2()
            .min_w_0()
            .w(px(460.).min(w.viewport_size().width - px(32.)))
            .child(
                div()
                    .h_flex()
                    .items_center()
                    .gap_2()
                    .child(
                        ui::text(Text::Label, source.status())
                            .id("tool-diff-status")
                            .test_support()
                            .aria_label(source.status())
                            .flex_1()
                            .min_w_0(),
                    )
                    .child(
                        ui::action("tool-diff-close", "Close", Action::Quiet).on_click(
                            move |_, w, cx| {
                                let _ = close_owner.update(cx, |v, cx| v.close(generation, w, cx));
                            },
                        ),
                    ),
            )
            .child(
                ui::text(Text::Body, source.paths.join("\n"))
                    .id("tool-diff-path")
                    .test_support()
                    .aria_label(source.paths.join("\n"))
                    .max_h(px(55.))
                    .overflow_y_scroll()
                    .min_w_0(),
            )
            .child(ui::text(Text::Caption, source_label).text_color(cx.theme().muted_foreground))
            .when(partial, |this| {
                this.child(
                    ui::text(
                        Text::Caption,
                        "Partial preview · copy includes only shown source",
                    )
                    .id("tool-diff-coverage")
                    .test_support()
                    .text_color(cx.theme().muted_foreground),
                )
            });
        if let Some((text, highlighter)) = text {
            let fonts = crate::typography::current(cx);
            let style = TextViewStyle::from_theme(&gpui_kit::base::Theme::global(cx))
                .with_foreground(cx.theme().foreground)
                .with_code_background(crate::appearance::code(cx));
            let mut code = style
                .code_block()
                .clone()
                .p_0()
                .border_0()
                .font_family(crate::typography::family(fonts.code_family, true, cx));
            if let Some(size) = fonts.code_size {
                code = code.text_size(px(size as f32 / 2.));
            }
            panel = panel.child(
                div()
                    .id("tool-diff-source")
                    .test_support()
                    .max_h(px(180.))
                    .overflow_y_scroll()
                    .min_w_0()
                    .bg(crate::appearance::code(cx))
                    .p_2()
                    .child(
                        TextView::new(text)
                            .style(style.with_code_block(code))
                            .shared_code_block_highlighter(highlighter)
                            .selectable(true)
                            .scrollable(false)
                            .on_link_click(|_, _, _, _| {}),
                    ),
            );
        }
        panel
            .child(
                ui::action("tool-diff-copy", "Copy shown preview", Action::Quiet)
                    .self_start()
                    .on_click(move |_, _, cx| {
                        let _ = owner.update(cx, |v, cx| {
                            if v.open && v.generation == generation {
                                cx.write_to_clipboard(ClipboardItem::new_string(
                                    v.shown.as_ref().clone(),
                                ));
                            }
                        });
                    }),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn color_ranges_leave_headers_neutral_and_preserve_literal_body_prefixes() {
        let source = "--- 日本.rs\n+++ 日本.rs\n@@ replacement hunk @@\n--- removed prefix\n+++ added prefix\n unchanged\n-👩‍💻\n+日本\r\n";
        let lines = diff_lines(source);
        assert_eq!(
            lines
                .iter()
                .map(|(r, add)| (&source[r.clone()], *add))
                .collect::<Vec<_>>(),
            vec![
                ("--- removed prefix", false),
                ("+++ added prefix", true),
                ("-👩‍💻", false),
                ("+日本", true)
            ]
        );
        let patch = "*** Add File: 日本.rs\n+++ literal added prefix\n";
        assert_eq!(diff_lines(patch).len(), 1);
        assert!(diff_lines("--- header only\n+++ header only\n").is_empty());
    }
    #[test]
    fn fenced_display_is_inert_even_with_markdown_fences_or_html_in_source() {
        for source in [
            "-```\n+<script>not markup</script>\n",
            "@@ hunk @@\n+日本 ``` ```` literal",
        ] {
            let display = fenced(source);
            let (header, rest) = display.split_once('\n').unwrap();
            let fence = header;
            assert!(fence.len() >= 4);
            assert!(rest.starts_with(source));
            assert!(display.ends_with(fence));
            let ink = DiffInk::new(
                gpui_kit::rgb(0x047857).into(),
                gpui_kit::rgb(0xdc2626).into(),
            );
            let block = CodeBlock::from_code(source, None::<gpui_kit::SharedString>);
            assert_eq!(block.code().as_ref(), source);
            let highlighted = (ink.highlight)(&block);
            for (range, style) in highlighted {
                assert!(source.is_char_boundary(range.start) && source.is_char_boundary(range.end));
                assert!(style.color.is_some());
                assert!(style.background_color.is_some());
            }
        }
    }
    fn tool(model: &mut crate::local_model::LiveTranscript) -> Arc<Tool> {
        model
            .rows()
            .iter()
            .find_map(|r| r.work_data().and_then(|w| w.calls().next().cloned()))
            .unwrap()
    }
    #[test]
    fn only_exact_call_arguments_supply_source_and_streaming_output_cannot_replace_it() {
        let mut m = crate::local_model::LiveTranscript::default();
        m.apply(&json!({"type":"entry_appended","entry":{"id":20,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"a","name":"edit","arguments":{"path":"日本.rs","oldText":"a<&>\n","newText":"b\n"}}]}]}}));
        m.apply(&json!({"type":"tool_execution_start","toolCallId":"a","toolName":"edit"}));
        let before = tool(&mut m);
        let source = Source::from_step(&Step::Tool(before.clone())).unwrap();
        assert_eq!(source.diff, before.diff);
        assert_eq!(shown(&source.diff), before.diff.as_ref().as_str());
        m.apply(&json!({"type":"tool_execution_update","toolCallId":"a","output":{"set":"--- fake\n+++ fake\n+must not appear"}}));
        assert!(Source::from_step(&Step::Tool(tool(&mut m))).is_some_and(|s| s == source));
        let mut changed = (*before).clone();
        changed.key += 1;
        assert!(
            Source::from_tool(&changed) != source,
            "Operation key is fenced"
        );
        changed = (*before).clone();
        changed.id = "b".into();
        assert!(
            Source::from_tool(&changed) != source,
            "Call identity is fenced"
        );
        changed = (*before).clone();
        changed.status = Status::Error;
        assert!(
            Source::from_tool(&changed) != source,
            "Status must invalidate old preview"
        );
        changed.diff = Arc::new(String::new());
        changed.output = source.diff.clone();
        assert!(
            Source::from_step(&Step::Tool(Arc::new(changed))).is_none(),
            "No output fallback"
        );
    }
    #[test]
    fn bounded_source_is_an_exact_utf8_prefix() {
        for source in [
            "日本👩‍💻e\u{301}".repeat(3000),
            "line\n".repeat(300),
            "-old\n+new\n".into(),
        ] {
            let preview = shown(&source);
            assert!(source.starts_with(&preview));
            assert!(preview.len() <= BYTE_CAP);
            assert!(preview.lines().count() <= LINE_CAP);
        }
    }
    #[test]
    fn status_never_claims_file_or_git_truth() {
        for (status, label) in [
            (Status::Pending, "Proposed"),
            (Status::Running, "Proposed"),
            (Status::Done, "Tool completed"),
            (Status::Error, "Attempted"),
            (Status::Interrupted, "Attempted"),
        ] {
            let s = Source {
                call: "id".into(),
                operation: 7,
                paths: vec!["a/日本.rs".into()],
                status,
                diff: Arc::new("+x".into()),
                limited: false,
                write: false,
            };
            assert!(s.status().starts_with(label));
            assert_eq!(s.label(), "日本.rs");
        }
    }
    #[test]
    fn patch_and_write_keep_their_own_source_and_honest_file_labels() {
        for (name, args, files, write) in [
            (
                "applyPatch",
                json!({"patch":"*** Begin Patch\n*** Update File: src/日本.rs\n@@\n-a\n+b\n*** Add File: src/é.rs\n+c\n*** End Patch"}),
                2,
                false,
            ),
            (
                "write",
                json!({"path":"src/é.rs","content":"written <&>"}),
                1,
                true,
            ),
        ] {
            let mut m = crate::local_model::LiveTranscript::default();
            m.apply(&json!({"type":"entry_appended","entry":{"id":20,"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"a","name":name,"arguments":args}]}]}}));
            let tool = tool(&mut m);
            let source = Source::from_tool(&tool);
            assert_eq!(source.paths.len(), files);
            assert_eq!(source.write, write);
            assert_eq!(source.diff, tool.diff);
            assert_eq!(
                source.label(),
                if files == 2 { "Patch files" } else { "é.rs" }
            );
        }
    }
}
