//! A passive list from the mission snapshot, opening one exact native reader.
use super::*;
use crate::{artifact_model::Reference, artifact_view::ArtifactPane, mission_artifacts::Link};
use gpui_kit::{AnyElement, Entity, KeyDownEvent, ListAlignment, ListState, list};

#[cfg(feature = "native-probes")]
#[path = "mission_artifacts_probe.rs"]
pub(crate) mod probe;

pub(super) struct Artifacts {
    pub(super) open: bool,
    list: ListState,
    selected: Option<String>,
    reader: Option<Entity<ArtifactPane>>,
    pub(super) reading: bool,
}
impl Default for Artifacts {
    fn default() -> Self {
        Self {
            open: false,
            list: ListState::new(0, ListAlignment::Top, px(800.)),
            selected: None,
            reader: None,
            reading: false,
        }
    }
}
impl Browser {
    fn artifact_links(&self) -> Result<&Arc<Vec<Link>>, &'static str> {
        self.detail
            .as_ref()
            .filter(|d| {
                self.route == Some(Route::Detail(d.key.clone()))
                    && self.local_home().as_ref() == Some(&d.key.home)
            })
            .ok_or("This mission's artifacts are unavailable.")?
            .artifacts
            .as_ref()
            .map_err(|e| *e)
    }
    pub(super) fn close_mission_artifacts(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.artifacts.open {
            self.artifacts.open = false;
            self.artifacts.reading = false;
            if let Some(p) = &self.artifacts.reader {
                p.update(cx, |p, _| p.close());
            }
            self.focus.focus(w, cx);
            cx.notify();
        }
    }
    pub(super) fn artifact_back(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.artifacts.reading {
            self.artifacts.reading = false;
            if let Some(p) = &self.artifacts.reader {
                p.update(cx, |p, _| p.close());
            }
            self.focus.focus(w, cx);
            cx.notify();
        } else {
            self.close_mission_artifacts(w, cx);
        }
    }
    fn open_mission_artifacts(&mut self, generation: u64, w: &mut Window, cx: &mut Context<Self>) {
        if generation != self.generation || self.brief_marked(w, cx) {
            return;
        }
        let Ok(rows) = self.artifact_links() else {
            return;
        };
        let count = rows.len();
        let first = rows.first().map(|r| r.key.clone());
        self.artifacts.list.reset(count);
        self.artifacts.selected = first;
        self.artifacts.open = true;
        self.focus.focus(w, cx);
        cx.notify();
    }
    fn open_mission_pin(
        &mut self,
        reference: Reference,
        generation: u64,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if generation != self.generation
            || !self.artifacts.open
            || !self.online
            || self.busy
            || self.error.is_some()
            || !self.artifact_links().is_ok_and(|links| {
                links
                    .iter()
                    .any(|l| l.reference.as_ref() == Some(&reference))
            })
        {
            return;
        }
        let Some(options) = self.options.clone() else {
            return;
        };
        self.artifacts.selected = self
            .artifact_links()
            .ok()
            .and_then(|links| {
                links
                    .iter()
                    .find(|l| l.reference.as_ref() == Some(&reference))
            })
            .map(|l| l.key.clone());
        if self.artifacts.reader.is_none() {
            let p = cx.new(|_| ArtifactPane::mission_pin());
            cx.subscribe_in(
                &p,
                w,
                |v, _, _: &crate::artifact_view::MissionBack, w, cx| {
                    if v.artifacts.open {
                        v.artifact_back(w, cx);
                    }
                },
            )
            .detach();
            self.artifacts.reader = Some(p);
        }
        self.artifacts.reading = true;
        self.artifacts.reader.as_ref().unwrap().update(cx, |p, cx| {
            p.options(options);
            p.context(Some(reference.session.clone()), Arc::new(Vec::new()), cx);
            p.open(reference, w, cx);
        });
        cx.notify();
    }
    pub(super) fn mission_artifacts_line(&self, d: &Detail, cx: &Context<Self>) -> AnyElement {
        let generation = self.generation;
        let count = match &d.artifacts {
            Ok(rows) => rows.len().to_string(),
            Err(_) => "Unavailable".into(),
        };
        let row = div()
            .h_flex()
            .w_full()
            .min_w_0()
            .items_center()
            .gap_2()
            .child(div().flex_1().min_w_0().child(ui::heading(
                "mission-artifacts-heading",
                "Artifacts",
                Text::Headline,
            )))
            .child(
                ui::text(Text::Caption, SharedString::from(count))
                    .text_color(cx.theme().muted_foreground),
            )
            .child(
                ui::action(
                    "mission-artifacts-open",
                    "Browse artifacts",
                    Action::Secondary,
                )
                .disabled(self.artifact_links().is_err())
                .on_click(
                    cx.listener(move |v, _, w, cx| v.open_mission_artifacts(generation, w, cx)),
                ),
            )
            .into_any_element();
        div()
            .v_flex()
            .w_full()
            .min_w_0()
            .gap_1()
            .child(row)
            .children(
                d.artifacts
                    .as_ref()
                    .err()
                    .map(|e| Notice::new(*e).tone(Tone::Warning)),
            )
            .into_any_element()
    }
    fn artifact_row(&self, ix: usize, cx: &Context<Self>) -> AnyElement {
        let Some(row) = self.artifact_links().ok().and_then(|r| r.get(ix)) else {
            return div().into_any_element();
        };
        let generation = self.generation;
        let reference = row.reference.clone();
        let meta = match &reference {
            None => "Unavailable: no valid pinned revision".into(),
            Some(r) => format!(
                "{} · r{}{}",
                crate::artifact_model::kind_label(&row.kind),
                r.revision,
                if matches!(row.kind.as_str(), "image" | "visual") {
                    ""
                } else {
                    " · source only"
                }
            ),
        };
        div()
            .w_full()
            .max_w(px(760.))
            .mx_auto()
            .px(px(Space::HOME))
            .py(px(Space::META))
            .child(
                ui::action(
                    SharedString::from(format!("mission-artifact-{}", row.key)),
                    "",
                    Action::Quiet,
                )
                .w_full()
                .h_auto()
                .py(px(Space::CONTROL))
                .justify_start()
                .selected(self.artifacts.selected.as_ref() == Some(&row.key))
                .disabled(reference.is_none() || !self.online || self.busy || self.error.is_some())
                .accessibility_label(SharedString::from(format!(
                    "{}. {meta}. Open artifact",
                    row.title
                )))
                .child(ResourceLabel::new(row.title.clone()).detail(meta))
                .on_click(cx.listener(move |v, _, w, cx| {
                    if let Some(reference) = &reference {
                        v.open_mission_pin(reference.clone(), generation, w, cx);
                    }
                })),
            )
            .into_any_element()
    }
    fn artifacts_key(&mut self, e: &KeyDownEvent, w: &mut Window, cx: &mut Context<Self>) {
        if e.keystroke.modifiers.modified() {
            return;
        }
        if e.keystroke.key == "escape" {
            self.artifact_back(w, cx);
            cx.stop_propagation();
            return;
        }
        if self.artifacts.reading {
            return;
        }
        let Ok(rows) = self.artifact_links() else {
            return;
        };
        if rows.is_empty() {
            return;
        }
        let current = rows
            .iter()
            .position(|r| Some(&r.key) == self.artifacts.selected.as_ref())
            .unwrap_or(0);
        let ix = match e.keystroke.key.as_str() {
            "up" => current.saturating_sub(1),
            "down" => (current + 1).min(rows.len() - 1),
            "enter" => {
                if let Some(reference) = rows[current].reference.clone() {
                    self.open_mission_pin(reference, self.generation, w, cx);
                }
                cx.stop_propagation();
                return;
            }
            _ => return,
        };
        let key = rows[ix].key.clone();
        self.artifacts.selected = Some(key);
        self.artifacts.list.scroll_to_reveal_item(ix);
        cx.stop_propagation();
        cx.notify();
    }
    pub(super) fn mission_artifacts_page(&self, cx: &Context<Self>) -> AnyElement {
        let mut page = div()
            .id("mission-artifacts-page")
            .test_support()
            .track_focus(&self.focus)
            .size_full()
            .min_h_0()
            .min_w_0()
            .v_flex()
            .on_key_down(cx.listener(|v, e, w, cx| v.artifacts_key(e, w, cx)));
        if self.artifacts.reading {
            return page
                .child(self.artifacts.reader.as_ref().unwrap().clone())
                .into_any_element();
        }
        let mut header = ui::page()
            .flex_none()
            .gap(px(Space::CONTROL))
            .pb(px(Space::CONTROL))
            .child(
                div().h_flex().child(
                    ui::action("mission-artifacts-back", "Back to mission", Action::Quiet)
                        .icon(crate::app_icon::AppIcon::Back.asset())
                        .on_click(cx.listener(|v, _, w, cx| v.close_mission_artifacts(w, cx))),
                ),
            )
            .child(ui::heading(
                "mission-artifacts-title",
                "Artifacts",
                Text::Title,
            ));
        if let Some(d) = &self.detail {
            header = header.child(ui::text(Text::Body, SharedString::from(d.title.clone())));
        }
        if !self.online || self.error.is_some() {
            header = header.child(Notice::new("Retained mission links. Opening artifacts needs a connection and a successful mission read.").tone(Tone::Warning));
        }
        match self.artifact_links() {
            Err(e) => header = header.child(Notice::new(e).tone(Tone::Warning)),
            Ok(rows) if rows.is_empty() => {
                header = header.child(ui::text(Text::Body, "No mission-level artifacts linked."))
            }
            Ok(_) => {}
        }
        page = page.child(header).child(
            div()
                .id("mission-artifacts-list")
                .test_support()
                .flex_1()
                .min_h_0()
                .w_full()
                .max_w(px(760.))
                .mx_auto()
                .child(
                    list(
                        self.artifacts.list.clone(),
                        cx.processor(|v, ix, _, cx| v.artifact_row(ix, cx)),
                    )
                    .size_full(),
                ),
        );
        page.into_any_element()
    }
}
