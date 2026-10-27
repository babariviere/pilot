//! Native presentation only. Plans arrive prepared off the UI thread in Scene.
use crate::{
    native_mermaid::{self as model, NODE_H, NODE_W, Prepared, Shape},
    ui,
};
use gpui_kit::{
    AnyElement, App, ClipboardItem, Context, FocusHandle, InteractiveElement, IntoElement,
    ParentElement, PathBuilder, Render, RenderOnce, SharedString, StatefulInteractiveElement,
    Styled, TestSupportExt, Window,
    base::SelectableText,
    canvas,
    component::{ActiveTheme, StyledExt},
    div, point,
    prelude::FluentBuilder,
    px,
};
use std::sync::Arc;

fn arrow_tip(end: [f32; 2], prior: [f32; 2]) -> [[f32; 2]; 3] {
    // f32::signum(0.0) is 1.0, not zero. Axis-aligned links need a
    // genuinely zero perpendicular component to keep arrowheads symmetric.
    let dx = (end[0] - prior[0]).clamp(-1., 1.);
    let dy = (end[1] - prior[1]).clamp(-1., 1.);
    [
        [end[0] - dx * 8. - dy * 4., end[1] - dy * 8. + dx * 4.],
        end,
        [end[0] - dx * 8. + dy * 4., end[1] - dy * 8. - dx * 4.],
    ]
}

#[derive(IntoElement)]
pub(crate) struct Element {
    id: SharedString,
    prepared: Arc<Prepared>,
    epoch: u64,
    scale: f32,
    reader: bool,
}
impl Element {
    pub(crate) fn new(id: String, prepared: Arc<Prepared>) -> Self {
        Self {
            id: id.into(),
            prepared,
            epoch: 0,
            scale: 1.,
            reader: false,
        }
    }
    pub(crate) fn scale(mut self, scale: f32) -> Self {
        self.scale = scale;
        self.reader = true;
        self
    }
    pub(crate) fn scope(mut self, epoch: u64) -> Self {
        self.epoch = epoch;
        self
    }
}
impl RenderOnce for Element {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        // Exact source, not a lossy hash, fences local disclosure/selection state.
        // Keyed state retires on unmount. It owns no jobs, timers or host callbacks.
        let key: SharedString =
            format!("{}:{}:{}", self.id, self.epoch, self.prepared.source).into();
        let scale = self.scale;
        let reader = self.reader;
        let view = window.use_keyed_state(key, cx, |_, cx| View {
            id: self.id,
            prepared: self.prepared,
            source: false,
            expanded: false,
            focus: cx.focus_handle(),
            scale,
            reader,
        });
        view.update(cx, |v, cx| {
            if v.scale != scale || v.reader != reader {
                v.scale = scale;
                v.reader = reader;
                cx.notify();
            }
        });
        view
    }
}
struct View {
    id: SharedString,
    prepared: Arc<Prepared>,
    source: bool,
    expanded: bool,
    focus: FocusHandle,
    scale: f32,
    reader: bool,
}
impl View {
    fn key(&self, suffix: &str) -> SharedString {
        format!("{}-{suffix}", self.id).into()
    }
    fn diagram(&self, diagram: &model::Diagram, cx: &App) -> AnyElement {
        let scale = self.scale;
        let plan = self.prepared.diagram.as_ref().unwrap().clone();
        let ink = cx.theme().foreground;
        let border = cx.theme().muted_foreground;
        let background = ui::Surface::Page.color(cx);
        let mut content = div()
            .id(self.key("drawing"))
            .test_support()
            .relative()
            .flex_shrink_0()
            .w(px(diagram.width * scale))
            .h(px(diagram.height * scale));
        content = content.child(
            canvas(
                |bounds, _, _| bounds,
                move |bounds, _, w, _| {
                    #[cfg(feature = "native-probes")]
                    let _timing =
                        crate::transcript_view::inline_visual::probe::scroll::work("mermaid_paint");
                    let draw =
                        |points: &[[f32; 2]], closed: bool, fill: bool, color, w: &mut Window| {
                            let mut path = if fill {
                                PathBuilder::fill()
                            } else {
                                PathBuilder::stroke(px(1.5 * scale))
                            };
                            path.move_to(
                                bounds.origin
                                    + point(px(points[0][0] * scale), px(points[0][1] * scale)),
                            );
                            for p in &points[1..] {
                                path.line_to(
                                    bounds.origin + point(px(p[0] * scale), px(p[1] * scale)),
                                );
                            }
                            if closed {
                                path.close();
                            }
                            if let Ok(path) = path.build() {
                                w.paint_path(path, color);
                            }
                        };
                    for route in &plan.routes {
                        draw(&route.points, false, false, border, w);
                        if route.edge.arrow {
                            let end = route.points[route.points.len() - 1];
                            // Last segment is always axis aligned and nonzero.
                            let prior = route
                                .points
                                .iter()
                                .rev()
                                .skip(1)
                                .find(|p| **p != end)
                                .unwrap();
                            let arrow = arrow_tip(end, *prior);
                            draw(&arrow, false, false, ink, w);
                        }
                    }
                    for node in &plan.nodes {
                        if node.node.shape == Shape::Diamond {
                            let (x, y) = (node.x, node.y);
                            let points = [
                                [x + NODE_W / 2., y],
                                [x + NODE_W, y + NODE_H / 2.],
                                [x + NODE_W / 2., y + NODE_H],
                                [x, y + NODE_H / 2.],
                            ];
                            draw(&points, true, true, background, w);
                            draw(&points, true, false, border, w);
                        }
                    }
                },
            )
            .absolute()
            .inset_0()
            .size_full(),
        );
        for node in &diagram.nodes {
            let diamond = node.node.shape == Shape::Diamond;
            let box_view = div()
                .absolute()
                .left(px(node.x * scale))
                .top(px(node.y * scale))
                .w(px(NODE_W * scale))
                .h(px(NODE_H * scale))
                .when(!diamond, |v| {
                    v.bg(background).border_1().border_color(border)
                })
                .when(node.node.shape == Shape::Rounded, |v| v.rounded_lg())
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .id(self.key(&format!("label-{}", node.node.id)))
                        .test_support()
                        .aria_label(SharedString::from(node.node.label.clone()))
                        .w(px(if diamond { 120. * scale } else { 208. * scale }))
                        .text_size(px(13. * scale))
                        .line_height(px(18. * scale))
                        .text_center()
                        .child(SelectableText::new(
                            self.key(&format!("text-{}", node.node.id)),
                            SharedString::from(model::wrapped(
                                &node.node.label,
                                if diamond { 8 } else { 15 },
                            )),
                        )),
                );
            content = content.child(box_view);
        }
        for (ix, route) in diagram.routes.iter().enumerate() {
            if !route.edge.label.is_empty() {
                content = content.child(
                    div()
                        .absolute()
                        .left(px(route.label_at[0] * scale))
                        .top(px(route.label_at[1] * scale))
                        .w(px(160. * scale))
                        .text_size(px(12. * scale))
                        .line_height(px(16. * scale))
                        .bg(background)
                        .child(SelectableText::new(
                            self.key(&format!("edge-{ix}")),
                            SharedString::from(model::wrapped(&route.edge.label, 12)),
                        )),
                );
            }
        }
        content.into_any_element()
    }
}
impl Render for View {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // The reader toolbar already names the artifact. This diagram's own
        // source toggle and copy are quiet icons, revealed on hover, while its
        // source is shown, or when the diagram failed to render.
        let group = SharedString::from(format!("{}-group", self.id));
        let pinned = self.source || self.prepared.diagram.is_err();
        let mut header = div()
            .absolute()
            .top_1()
            .right_1()
            .h_flex()
            .items_center()
            .gap_1()
            .when(!pinned, |h| {
                h.opacity(0.).group_hover(group.clone(), |s| s.opacity(1.))
            })
            .when(self.prepared.diagram.is_ok(), |header| {
                header.child(
                    ui::icon_action(
                        self.key("source"),
                        if self.source {
                            "Show diagram"
                        } else {
                            "Show Mermaid source"
                        },
                        crate::app_icon::AppIcon::Source,
                        ui::Action::Quiet,
                    )
                    .on_click(cx.listener(|v, _, w, cx| {
                        v.source = !v.source;
                        v.focus.focus(w, cx);
                        cx.notify();
                    })),
                )
            })
            .child(
                ui::icon_action(
                    self.key("copy"),
                    "Copy Mermaid source",
                    crate::app_icon::AppIcon::Copy,
                    ui::Action::Quiet,
                )
                .on_click(cx.listener(|v, _, _, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string(
                        v.prepared.source.to_string(),
                    ))
                })),
            );
        if self.prepared.diagram.is_ok() && !self.reader {
            header = header.child(
                ui::action(
                    self.key("expand"),
                    if self.expanded { "Collapse" } else { "Expand" },
                    ui::Action::Quiet,
                )
                .on_click(cx.listener(|v, _, w, cx| {
                    v.expanded = !v.expanded;
                    v.focus.focus(w, cx);
                    cx.notify();
                })),
            );
        }
        let height: f32 = if self.expanded { 600. } else { 480. };
        let mut root = div()
            .id(self.id.clone())
            .test_support()
            .group(group)
            .relative()
            .track_focus(&self.focus)
            .tab_stop(true)
            .w_full()
            .min_w_0()
            .v_flex()
            .gap_2()
            .text_color(cx.theme().foreground);
        let body = match &self.prepared.diagram {
            Ok(diagram) if !self.source => div()
                .id(self.key("viewport"))
                .test_support()
                .w_full()
                .min_w_0()
                .h(px(if self.reader {
                    diagram.height * self.scale
                } else {
                    height.min(diagram.height)
                }))
                .overflow_scroll()
                .bg(ui::Surface::Page.color(cx))
                .child(self.diagram(diagram, cx))
                .into_any_element(),
            _ => div()
                .id(self.key("source-viewport"))
                .test_support()
                .overflow_scroll()
                .min_w_0()
                .w_full()
                .h(px(height))
                .bg(ui::Surface::Code.color(cx))
                .p_3()
                .font_family(cx.theme().mono_font_family.clone())
                .text_size(px(12.))
                .line_height(px(18.))
                .child(SelectableText::new(
                    self.key("source-text"),
                    SharedString::from(self.prepared.source.to_string()),
                ))
                .into_any_element(),
        };
        if let Err(reason) = self.prepared.diagram {
            let tone = if matches!(reason, model::Bad::Unsupported(_)) {
                ui::Tone::Warning
            } else {
                ui::Tone::Error
            };
            root=root.child(div().id(self.key("error")).test_support().aria_label(reason.heading()).pr(px(72.))
                .child(ui::Notice::new(reason.heading()).tone(tone).detail(SharedString::from(format!("{} Its source is shown below.",reason.detail())))));
        }
        // Header last so it paints over the diagram's top-right corner.
        root.child(body).child(header)
    }
}

#[cfg(test)]
mod tests {
    use super::arrow_tip;
    #[test]
    fn arrowheads_are_symmetric_and_follow_all_four_axis_directions() {
        assert_eq!(
            arrow_tip([20., 20.], [20., 0.]),
            [[16., 12.], [20., 20.], [24., 12.]]
        );
        assert_eq!(
            arrow_tip([20., 20.], [20., 40.]),
            [[24., 28.], [20., 20.], [16., 28.]]
        );
        assert_eq!(
            arrow_tip([20., 20.], [0., 20.]),
            [[12., 24.], [20., 20.], [12., 16.]]
        );
        assert_eq!(
            arrow_tip([20., 20.], [40., 20.]),
            [[28., 16.], [20., 20.], [28., 24.]]
        );
    }
}
