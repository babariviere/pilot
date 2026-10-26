//! Native tray component. No reads, writes, timers, tool inspection or auto-disclosure.
//! MonoCode TaskListPreview.tsx @26465c620977f3951d0a532a0f7db32c3c179007;
//! MIT © 2026 Nick, licenses/MONOCODE.txt. Swift TasksStrip supplies tray placement.
use crate::{
    app_icon::AppIcon,
    session_todos::{Phase, Snapshot},
    ui::{self, Text},
};
use gpui_kit::{
    App, Div, InteractiveElement, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, TestSupportExt,
    component::{ActiveTheme, StyledExt},
    div,
    prelude::FluentBuilder,
    px,
};

/// App-owned passive list. The caller supplies the real disclosure Button and intent.
pub(crate) fn rows(snapshot: &Snapshot, phase: Phase, cx: &App) -> Div {
    let mut content = div().v_flex().min_w_0().gap_1();
    if phase == Phase::Retained {
        content = content.child(
            ui::text(
                Text::Caption,
                "Tasks unavailable or reconnecting. Last reported snapshot retained.",
            )
            .id("session-todos-retained")
            .test_support()
            .text_color(cx.theme().muted_foreground),
        );
    }
    if let Some(coverage) = snapshot.coverage() {
        content = content.child(
            ui::text(Text::Caption, SharedString::from(coverage))
                .id("session-todos-coverage")
                .test_support()
                .text_color(cx.theme().muted_foreground),
        );
    }
    if snapshot.rows.is_empty() {
        return content.child(
            ui::text(Text::Caption, "The public task snapshot is empty.")
                .text_color(cx.theme().muted_foreground),
        );
    }
    content.child(
        div()
            .id("session-todos-list")
            .test_support()
            .v_flex()
            .min_w_0()
            .max_h(px(112.))
            .overflow_y_scroll()
            .children(snapshot.rows.iter().map(|todo| {
                let description = SharedString::from(format!(
                    "{}: {} ({})",
                    todo.title,
                    todo.status,
                    todo.label()
                ));
                div()
                    .id(SharedString::from(format!("session-todo:{}", todo.id)))
                    .test_support()
                    .h_flex()
                    .min_w_0()
                    .h(px(28.))
                    .min_h(px(28.))
                    .flex_shrink_0()
                    .gap_2()
                    .px_1()
                    .text_color(if todo.working {
                        cx.theme().foreground
                    } else {
                        cx.theme().muted_foreground
                    })
                    .child(
                        if todo.closed {
                            AppIcon::Complete
                        } else if todo.working {
                            AppIcon::Working
                        } else {
                            AppIcon::Todo
                        }
                        .inline(),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .when(todo.working, |d| d.font_medium())
                            .child(ui::text(
                                Text::Label,
                                SharedString::from(todo.title.clone()),
                            )),
                    )
                    .child(
                        ui::text(Text::Caption, SharedString::from(todo.label().to_owned()))
                            .max_w(px(120.))
                            .truncate(),
                    )
                    .tooltip(move |w, cx| {
                        gpui_kit::component::tooltip::Tooltip::new(description.clone()).build(w, cx)
                    })
                    .into_any_element()
            })),
    )
}

pub(crate) fn summary(snapshot: &Snapshot, expanded: bool, cx: &App) -> Div {
    div()
        .h_flex()
        .w_full()
        .min_w_0()
        .gap_2()
        .text_left()
        .child(AppIcon::Tasks.inline())
        .child(ui::text(Text::Label, SharedString::from(snapshot.summary())).flex_shrink_0())
        .when(snapshot.count > 0 && !snapshot.partial, |d| {
            d.child(
                div()
                    .w(px(40.))
                    .h(px(3.))
                    .flex_shrink_0()
                    .bg(cx.theme().border)
                    .rounded_full()
                    .overflow_hidden()
                    .child(
                        div()
                            .h_full()
                            .w(px(40. * snapshot.done as f32 / snapshot.count as f32))
                            .bg(cx.theme().muted_foreground),
                    ),
            )
        })
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .font_medium()
                .child(SharedString::from(if expanded {
                    String::new()
                } else {
                    snapshot
                        .rows
                        .iter()
                        .find(|t| t.working)
                        .map(|t| t.title.clone())
                        .unwrap_or_default()
                })),
        )
        .child(disclosure_icon(expanded).inline())
}

fn disclosure_icon(expanded: bool) -> AppIcon {
    if expanded {
        AppIcon::Collapse
    } else {
        AppIcon::Expand
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::AssetSource;
    #[test]
    fn disclosure_uses_loaded_chevrons_not_navigation_arrows() {
        for (expanded, path) in [
            (false, "icons/chevron-down.svg"),
            (true, "icons/chevron-up.svg"),
        ] {
            let icon = disclosure_icon(expanded).asset();
            assert_eq!(icon.path().as_ref(), path);
            assert!(crate::ChromeAssets.load(path).unwrap().is_some());
        }
    }
}
