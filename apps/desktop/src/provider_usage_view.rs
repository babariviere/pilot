//! Compact, display-only Home subscription bars: Swift SubscriptionUsageBars parity.
//! No refresh or provider actions. Details disclose cached text the caller toggles.
use crate::{
    provider_usage::{Snapshot, Window as UsageWindow},
    ui::{self, Action, IconRole, Space, Text},
};
use gpui_kit::{
    App, ClickEvent, InteractiveElement, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, TestSupportExt,
    component::{ActiveTheme, Sizable, StyledExt},
    div, px, relative,
};

/// A caller-owned listener that toggles one provider's details.
pub(crate) type Toggle = Box<dyn Fn(&ClickEvent, &mut gpui_kit::Window, &mut App)>;

// Swift SubscriptionUsageBars metrics: caption rows, 48x4pt bars, 6pt inside a
// cell, 20pt between cells and 12pt after the provider slot.
const METER: f32 = 48.;
const CELL_GAP: f32 = 6.;
const COLUMN_GAP: f32 = 20.;
const PROVIDER_GAP: f32 = 12.;
/// Fits "Claude" and "Codex" at caption size, so columns line up across rows.
const PROVIDER: f32 = 40.;
/// Fits "100%", so bars line up across rows.
const VALUE: f32 = 28.;
/// Swift SubscriptionUsage.staleAfter.
const STALE_MS: u64 = 10 * 60 * 1000;

/// Home column: hour limits by length, then weekly, then others, then extra usage.
fn column(w: &UsageWindow) -> (u32, String) {
    if w.extra {
        return (30_000, "Extra".into());
    }
    let lower = w.label.to_lowercase();
    if let Some(hours) = lower.strip_suffix('h').and_then(|n| n.parse::<u32>().ok()) {
        return (hours, format!("{hours}-hour"));
    }
    if matches!(lower.as_str(), "week" | "weekly" | "7d") {
        return (10_000, "Weekly".into());
    }
    (20_000, w.label.clone())
}

fn columns(snapshots: &[Snapshot]) -> Vec<(u32, String)> {
    let mut seen: Vec<(u32, usize, String)> = Vec::new();
    for w in snapshots.iter().flat_map(|s| &s.windows) {
        let (rank, label) = column(w);
        if !seen.iter().any(|(_, _, l)| *l == label) {
            seen.push((rank, seen.len(), label));
        }
    }
    seen.sort();
    seen.into_iter()
        .map(|(rank, _, label)| (rank, label))
        .collect()
}

/// The value after a bar: the percent for a limit, the spend for extra usage.
fn value(w: &UsageWindow) -> String {
    if w.extra {
        w.value
            .split('/')
            .map(|a| a.strip_suffix(".00").unwrap_or(a))
            .collect::<Vec<_>>()
            .join("/")
    } else {
        w.value.trim_end_matches(" used").to_owned()
    }
}

/// A reset that already passed makes the reported share history, never zero.
fn expired(w: &UsageWindow, now: i64) -> Option<i64> {
    w.resets_at.filter(|at| !w.extra && *at <= now)
}

/// Visible, concise state that the bars alone would hide.
fn status(s: &Snapshot, now_ms: u64) -> Option<String> {
    let mut parts = Vec::new();
    if s.update_error {
        parts.push("update failed");
    }
    match s.fetched_at {
        None => parts.push("time unknown"),
        Some(at) if at > now_ms => parts.push("report time in the future"),
        Some(at) if now_ms - at > STALE_MS => parts.push("not recent"),
        Some(_) => {}
    }
    if s.windows.is_empty() && !s.update_error {
        parts.push("no usage reported");
    }
    (!parts.is_empty()).then(|| parts.join(" · "))
}

/// Report time, every window with its reset, and provenance. Shown in the
/// tooltip and in the expanded details.
fn details(s: &Snapshot, now_ms: u64) -> Vec<String> {
    let now = (now_ms / 1000) as i64;
    let mut lines = vec![match s.fetched_at {
        Some(at) if at <= now_ms => {
            let time = crate::message_time::label(at);
            if now_ms - at <= STALE_MS {
                format!("Reported {time}")
            } else {
                format!("Reported {time} · not recent")
            }
        }
        _ => s.freshness(now_ms),
    }];
    if s.update_error {
        lines.push(if s.windows.is_empty() {
            "Couldn't update subscription usage".into()
        } else {
            "Couldn't update subscription usage. Showing the last report.".into()
        });
    } else if s.windows.is_empty() {
        lines.push("No usage windows reported".into());
    }
    for w in &s.windows {
        lines.push(match expired(w, now) {
            Some(at) => format!(
                "{}: last report {} · reset {} · awaiting report",
                w.label,
                w.value,
                crate::subscription_pause::clock(at, now)
            ),
            None => format!("{}: {} · {}", w.label, w.value, w.reset(now)),
        });
    }
    lines.push(s.help());
    lines
}

/// One compact row per provider, Claude then Codex, under Home's summary.
/// The open list holds the providers whose details are expanded.
pub(crate) fn section(
    snapshots: &[Snapshot],
    open: &[&'static str],
    now_ms: u64,
    toggle: impl Fn(&'static str) -> Toggle,
    cx: &App,
) -> Option<impl IntoElement> {
    if snapshots.is_empty() {
        return None;
    }
    let muted = cx.theme().muted_foreground;
    let now = (now_ms / 1000) as i64;
    let columns = columns(snapshots);
    let mut section = div()
        .id("home-subscriptions")
        .test_support()
        .v_flex()
        // Providers sit a little further apart than a wrapped row's lines.
        .gap(px(Space::CONTROL))
        .pt(px(Space::META))
        .text_size(px(Text::Caption.size()))
        .text_color(muted);
    for s in snapshots {
        let provider = s.provider;
        let id = format!("home-subscription-{provider}");
        let expanded = open.contains(&provider);
        let status = status(s, now_ms);
        let lines = details(s, now_ms);
        let tip = SharedString::from(lines.join("\n"));
        let mut cells = div()
            .h_flex()
            .flex_wrap()
            .items_center()
            .min_w_0()
            .gap_x(px(COLUMN_GAP))
            .gap_y(px(Space::META));
        let mut spoken = Vec::new();
        // Keep a missing hour or weekly column's width when a later column follows, so
        // bars align. Provider-specific columns never reserve space in another row.
        let last = columns
            .iter()
            .rposition(|(_, c)| s.windows.iter().any(|w| column(w).1 == *c));
        for (col_ix, (rank, col)) in columns.iter().enumerate() {
            if last.is_none_or(|last| col_ix > last) {
                break;
            }
            let Some((ix, w)) = s
                .windows
                .iter()
                .enumerate()
                .find(|(_, w)| column(w).1 == *col)
            else {
                if *rank < 20_000 {
                    cells = cells.child(
                        div()
                            .h_flex()
                            .invisible()
                            .gap(px(CELL_GAP))
                            .child(SharedString::from(col.clone()))
                            .child(div().w(px(METER)).h(px(4.)))
                            .child(div().min_w(px(VALUE))),
                    );
                }
                continue;
            };
            let cell_id = format!("{id}-window-{ix}");
            let mut cell = div()
                .id(SharedString::from(cell_id.clone()))
                .test_support()
                .h_flex()
                .items_center()
                .min_w_0()
                .max_w_full()
                .gap(px(CELL_GAP))
                .child(
                    ui::text(Text::Caption, col.clone())
                        .id(SharedString::from(format!("{cell_id}-label")))
                        .test_support()
                        .min_w_0(),
                );
            let said = if expired(w, now).is_some() {
                let last = format!("was {} · awaiting report", value(w));
                cell = cell.child(
                    ui::text(Text::Caption, last.clone())
                        .id(SharedString::from(format!("{cell_id}-last")))
                        .test_support()
                        .min_w_0(),
                );
                format!("{col} {last}")
            } else {
                cell = cell
                    .child(
                        div()
                            .id(SharedString::from(format!("{cell_id}-meter")))
                            .test_support()
                            .flex_shrink_0()
                            .w(px(METER))
                            .h(px(4.))
                            .rounded_full()
                            .overflow_hidden()
                            .bg(cx.theme().border)
                            .child(
                                div()
                                    .id(SharedString::from(format!("{cell_id}-fill")))
                                    .test_support()
                                    .h_full()
                                    .w(relative(f32::from(w.basis_points) / 10_000.))
                                    .bg(if w.warning { cx.theme().warning } else { muted }),
                            ),
                    )
                    .child(
                        ui::text(Text::Caption, value(w))
                            .id(SharedString::from(format!("{cell_id}-value")))
                            .test_support()
                            .min_w(px(VALUE))
                            .text_right()
                            .flex_shrink_0(),
                    );
                if w.extra {
                    format!("{col} {} spent", value(w))
                } else {
                    format!("{col} {} used", value(w))
                }
            };
            cells = cells.child(cell.aria_label(said.clone()));
            spoken.push(said);
        }
        if let Some(status) = &status {
            cells = cells.child(
                ui::text(Text::Caption, status.clone())
                    .id(SharedString::from(format!("{id}-status")))
                    .test_support()
                    .aria_label(status.clone())
                    .min_w_0(),
            );
            spoken.push(status.clone());
        }
        let current = status.is_none();
        let row = div()
            .id(SharedString::from(id.clone()))
            .test_support()
            .aria_label(format!("{provider} subscription: {}", spoken.join(", ")))
            .h_flex()
            .items_start()
            .min_w_0()
            .gap(px(PROVIDER_GAP))
            .tooltip(move |w, cx| {
                gpui_kit::component::tooltip::Tooltip::new(tip.clone()).build(w, cx)
            })
            .child(
                ui::text(Text::Caption, provider)
                    .flex_shrink_0()
                    .min_w(px(PROVIDER))
                    .text_color(if current {
                        cx.theme().foreground
                    } else {
                        muted
                    }),
            )
            .child(cells)
            .child(
                ui::icon_action(
                    SharedString::from(format!("{id}-details-toggle")),
                    format!(
                        "{} {provider} subscription details",
                        if expanded { "Hide" } else { "Show" }
                    ),
                    if expanded {
                        IconRole::Collapse
                    } else {
                        IconRole::Expand
                    },
                    Action::Quiet,
                )
                .xsmall()
                .flex_shrink_0()
                .on_click(toggle(provider)),
            );
        let mut group = div().v_flex().min_w_0().gap(px(Space::META)).child(row);
        if expanded {
            group = group.child(
                div()
                    .id(SharedString::from(format!("{id}-details")))
                    .test_support()
                    .aria_label(lines.join(". "))
                    .v_flex()
                    .min_w_0()
                    .gap(px(Space::META))
                    .pl(px(PROVIDER + PROVIDER_GAP))
                    .children(
                        lines
                            .into_iter()
                            .map(|l| ui::text(Text::Caption, l).min_w_0()),
                    ),
            );
        }
        section = section.child(group);
    }
    Some(section)
}
