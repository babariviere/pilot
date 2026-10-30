//! Existing reported links, with exact captured actions and no resource writes.
use super::*;
use crate::mission_resources::Resource;
use gpui_kit::{AnyElement, KeyDownEvent, ListAlignment, ListState, list};

#[cfg(feature = "native-probes")]
#[path = "mission_resources_probe.rs"]
pub(crate) mod probe;

pub(super) struct Resources {
    pub(super) open: bool,
    list: ListState,
    selected: Option<String>,
    detail: bool,
}
impl Default for Resources {
    fn default() -> Self {
        Self {
            open: false,
            list: ListState::new(0, ListAlignment::Top, px(800.)),
            selected: None,
            detail: false,
        }
    }
}
impl Browser {
    fn resource_rows(&self) -> Result<&Arc<Vec<Resource>>, &'static str> {
        self.detail
            .as_ref()
            .filter(|d| {
                self.route == Some(Route::Detail(d.key.clone()))
                    && self.local_home().as_ref() == Some(&d.key.home)
            })
            .ok_or("This mission's links are unavailable.")?
            .resources
            .as_ref()
            .map_err(|e| *e)
    }
    pub(super) fn close_mission_resources(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.resources.open {
            self.resources.open = false;
            self.resources.detail = false;
            self.focus.focus(w, cx);
            cx.notify();
        }
    }
    fn resources_back(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.resources.detail {
            self.resources.detail = false;
            self.focus.focus(w, cx);
            cx.notify();
        } else {
            self.close_mission_resources(w, cx);
        }
    }
    fn open_resources(&mut self, generation: u64, w: &mut Window, cx: &mut Context<Self>) {
        if generation != self.generation || self.brief_marked(w, cx) {
            return;
        }
        let Ok(rows) = self.resource_rows() else {
            return;
        };
        let count = rows.len();
        let selected = rows.first().map(|r| r.id.clone());
        self.resources.list.reset(count);
        self.resources.selected = selected;
        self.resources.detail = false;
        self.resources.open = true;
        self.focus.focus(w, cx);
        cx.notify();
    }
    fn resource_captured(&self, row: &Resource, generation: u64) -> bool {
        self.resources.open
            && generation == self.generation
            && self.resource_rows().is_ok_and(|rows| rows.contains(row))
    }
    fn resources_fresh(&self) -> bool {
        self.resources_current && self.online && self.loaded && !self.busy && self.error.is_none()
    }
    fn resource_details(
        &mut self,
        row: &Resource,
        generation: u64,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.resource_captured(row, generation) {
            return;
        }
        self.resources.selected = Some(row.id.clone());
        self.resources.detail = true;
        self.focus.focus(w, cx);
        cx.notify();
    }
    fn resource_copy(&self, row: &Resource, generation: u64, cx: &mut Context<Self>) {
        if self.resource_captured(row, generation) {
            cx.write_to_clipboard(ClipboardItem::new_string(row.url.clone()));
        }
    }
    fn resource_open(&self, row: &Resource, generation: u64, cx: &mut Context<Self>) {
        if self.resource_captured(row, generation)
            && self.resources_fresh()
            && let Some(url) = crate::external_links::web(&row.url)
        {
            crate::external_links::open(&url, cx);
        }
    }
    fn resource_task(
        &mut self,
        row: &Resource,
        generation: u64,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.resource_captured(row, generation)
            || !self.resources_fresh()
            || !row.task_available
        {
            return;
        }
        self.close_mission_resources(w, cx);
        self.reveal_task(row.task.clone(), generation, w, cx);
    }
    pub(super) fn mission_resources_line(&self, d: &Detail, cx: &Context<Self>) -> AnyElement {
        let generation = self.generation;
        div()
            .v_flex()
            .w_full()
            .min_w_0()
            .gap_1()
            .child(
                div()
                    .h_flex()
                    .w_full()
                    .min_w_0()
                    .gap_2()
                    .child(div().flex_1().min_w_0().child(ui::heading(
                        "mission-links-heading",
                        "Links",
                        Text::Headline,
                    )))
                    .child(
                        ui::text(
                            Text::Caption,
                            SharedString::from(
                                d.resources
                                    .as_ref()
                                    .map_or_else(|_| "Unavailable".into(), |r| r.len().to_string()),
                            ),
                        )
                        .text_color(cx.theme().muted_foreground),
                    )
                    .child(
                        ui::action("mission-links-browse", "Browse links", Action::Secondary)
                            .disabled(self.resource_rows().is_err())
                            .on_click(
                                cx.listener(move |v, _, w, cx| v.open_resources(generation, w, cx)),
                            ),
                    ),
            )
            .children(
                d.resources
                    .as_ref()
                    .err()
                    .map(|e| Notice::new(*e).tone(Tone::Warning)),
            )
            .into_any_element()
    }
    fn resource_row(&self, ix: usize, cx: &Context<Self>) -> AnyElement {
        let Some(row) = self.resource_rows().ok().and_then(|r| r.get(ix)) else {
            return div().into_any_element();
        };
        let generation = self.generation;
        let row = row.clone();
        div()
            .w_full()
            .max_w(px(760.))
            .mx_auto()
            .px(px(Space::HOME))
            .py(px(Space::META))
            .child(
                ui::action(
                    SharedString::from(format!("mission-link-{}", row.id)),
                    "",
                    Action::Quiet,
                )
                .w_full()
                .h_auto()
                .py(px(Space::CONTROL))
                .justify_start()
                .selected(self.resources.selected.as_ref() == Some(&row.id))
                .accessibility_label(SharedString::from(format!(
                    "{}. {}. Link details",
                    row.title,
                    row.summary()
                )))
                .child(ResourceLabel::new(row.title.clone()).detail(row.summary()))
                .on_click(
                    cx.listener(move |v, _, w, cx| v.resource_details(&row, generation, w, cx)),
                ),
            )
            .into_any_element()
    }
    fn resources_key(&mut self, e: &KeyDownEvent, w: &mut Window, cx: &mut Context<Self>) {
        if e.keystroke.modifiers.modified() {
            return;
        }
        if e.keystroke.key == "escape" {
            self.resources_back(w, cx);
            cx.stop_propagation();
            return;
        }
        // Let mounted buttons own Return; otherwise it would also reopen the row.
        if self.resources.detail || !self.focus.is_focused(w) {
            return;
        }
        let Ok(rows) = self.resource_rows() else {
            return;
        };
        if rows.is_empty() {
            return;
        }
        let current = rows
            .iter()
            .position(|r| Some(&r.id) == self.resources.selected.as_ref())
            .unwrap_or(0);
        let ix = match e.keystroke.key.as_str() {
            "up" => current.saturating_sub(1),
            "down" => (current + 1).min(rows.len() - 1),
            "home" => 0,
            "end" => rows.len() - 1,
            "enter" => {
                let row = rows[current].clone();
                self.resource_details(&row, self.generation, w, cx);
                cx.stop_propagation();
                return;
            }
            _ => return,
        };
        self.resources.selected = Some(rows[ix].id.clone());
        self.resources.list.scroll_to_reveal_item(ix);
        cx.stop_propagation();
        cx.notify();
    }
    pub(super) fn mission_resources_page(&self, cx: &Context<Self>) -> AnyElement {
        let generation = self.generation;
        let mut header = ui::page()
            .flex_none()
            .gap(px(Space::CONTROL))
            .pb(px(Space::CONTROL))
            .child(
                div().h_flex().child(
                    ui::action(
                        "mission-links-back",
                        if self.resources.detail {
                            "Back to links"
                        } else {
                            "Back to mission"
                        },
                        Action::Quiet,
                    )
                    .icon(crate::app_icon::AppIcon::Back.asset())
                    .on_click(cx.listener(|v, _, w, cx| v.resources_back(w, cx))),
                ),
            )
            .child(ui::heading("mission-links-title", "Links", Text::Title));
        if let Some(d) = &self.detail {
            header = header.child(ui::text(Text::Body, SharedString::from(d.title.clone())));
        }
        header = header.child(ui::text(
            Text::Caption,
            "Reported links, not verified PR binding, current external status or approval.",
        ));
        if !self.resources_fresh() {
            header = header.child(Notice::new("Retained mission links. Copy is available; refresh the mission after connecting to open links or tasks.").tone(Tone::Warning));
        }
        let mut page = div()
            .id("mission-links-page")
            .test_support()
            .track_focus(&self.focus)
            .size_full()
            .min_w_0()
            .min_h_0()
            .v_flex()
            .on_key_down(cx.listener(|v, e, w, cx| v.resources_key(e, w, cx)))
            .child(header);
        match self.resource_rows() {
            Err(e) => {
                return page
                    .child(ui::page().child(Notice::new(e).tone(Tone::Warning)))
                    .into_any_element();
            }
            Ok(rows) if rows.is_empty() => {
                return page
                    .child(ui::page().child(ui::text(
                        Text::Body,
                        "No links reported for this mission or its tasks.",
                    )))
                    .into_any_element();
            }
            Ok(_) => {}
        }
        if self.resources.detail {
            if let Some(row) = self.resource_rows().ok().and_then(|rows| {
                rows.iter()
                    .find(|r| Some(&r.id) == self.resources.selected.as_ref())
            }) {
                let mut detail = ui::page()
                    .id(SharedString::from(format!(
                        "mission-link-scope-{}-{generation}",
                        row.id
                    )))
                    .gap(px(Space::SECTION))
                    .child(self.plain("mission-link-title", row.title.clone()))
                    .child(self.plain("mission-link-url", row.url.clone()))
                    .child(ui::text(Text::Body, SharedString::from(row.summary())));
                for text in &row.metadata {
                    detail =
                        detail.child(ui::text(Text::Caption, SharedString::from(text.clone())));
                }
                if crate::external_links::web(&row.url).is_none() {
                    detail = detail.child(Notice::new("Unsupported or unsafe URL. Only valid HTTP and HTTPS links can open; Copy preserves the reported URL.").tone(Tone::Warning));
                }
                let open = row.clone();
                let copy = row.clone();
                let task = row.clone();
                let mut actions = div()
                    .h_flex()
                    .flex_wrap()
                    .gap_2()
                    .child(
                        ui::action("mission-link-open", "Open link", Action::Secondary)
                            .icon(crate::app_icon::AppIcon::OpenLink.asset())
                            .accessibility_label(SharedString::from(format!(
                                "Open link: {}",
                                row.title
                            )))
                            .disabled(
                                !self.resources_fresh()
                                    || crate::external_links::web(&row.url).is_none(),
                            )
                            .on_click(cx.listener(move |v, _, _, cx| {
                                v.resource_open(&open, generation, cx)
                            })),
                    )
                    .child(
                        ui::action("mission-link-copy", "Copy link", Action::Secondary).on_click(
                            cx.listener(move |v, _, _, cx| v.resource_copy(&copy, generation, cx)),
                        ),
                    );
                if row.task.is_some() {
                    actions = actions.child(
                        ui::action("mission-link-task", "Show task", Action::Quiet)
                            .accessibility_label(SharedString::from(format!(
                                "Show {}",
                                row.task_label
                            )))
                            .disabled(!self.resources_fresh() || !row.task_available)
                            .on_click(cx.listener(move |v, _, w, cx| {
                                v.resource_task(&task, generation, w, cx)
                            })),
                    );
                }
                page = page.child(
                    div()
                        .id("mission-link-details")
                        .test_support()
                        .flex_1()
                        .min_h_0()
                        .w_full()
                        .overflow_y_scroll()
                        .child(detail.child(actions)),
                );
            }
        } else {
            page = page.child(
                div()
                    .id("mission-links-list")
                    .test_support()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .max_w(px(760.))
                    .mx_auto()
                    .child(
                        list(
                            self.resources.list.clone(),
                            cx.processor(|v, ix, _, cx| v.resource_row(ix, cx)),
                        )
                        .size_full(),
                    ),
            );
        }
        page.into_any_element()
    }
}
