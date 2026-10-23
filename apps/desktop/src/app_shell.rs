//! Bounded Local app-shell projections. No I/O, authority or canonical writes.
use crate::local_model::{Chat, Project};
use gpui_kit::{
    App, Context, EventEmitter, InteractiveElement, IntoElement, ParentElement, Render,
    SharedString, Styled, Task, TestSupportExt, Window,
    component::{
        ActiveTheme, IndexPath, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        list::{ListDelegate, ListItem, ListState},
        scroll::ScrollableElement,
    },
    div, px,
};
use std::{collections::BTreeMap, sync::Arc};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Page {
    Home,
    Inbox(Option<String>),
    Project(String),
    Chat,
}
pub(crate) enum ShellEvent {
    Project(String),
    Chat(String),
    AllChats,
}
pub(crate) struct OverviewInput {
    pub(crate) projects: Arc<Vec<Project>>,
    pub(crate) chats: Arc<Vec<Chat>>,
    pub(crate) project: Option<String>,
    pub(crate) projects_loaded: bool,
    pub(crate) chats_loaded: bool,
    pub(crate) error: Option<&'static str>,
}
#[derive(Clone, Copy, Default)]
struct Counts {
    chats: usize,
    working: usize,
    attention: usize,
    ready: usize,
}
impl Counts {
    fn add(&mut self, c: &Chat) {
        use crate::dither::Signal;
        self.chats += 1;
        self.working += usize::from(c.signal == Some(Signal::Working));
        self.attention += usize::from(matches!(c.signal, Some(Signal::Failed | Signal::NeedsYou)));
        self.ready += usize::from(c.signal == Some(Signal::Ready));
    }
    fn line(self) -> String {
        let mut parts = vec![format!(
            "{} loaded chat{}",
            self.chats,
            if self.chats == 1 { "" } else { "s" }
        )];
        if self.working > 0 {
            parts.push(format!("{} working", self.working));
        }
        if self.attention > 0 {
            parts.push(format!("{} need you", self.attention));
        }
        if self.ready > 0 {
            parts.push(format!("{} ready to merge", self.ready));
        }
        parts.join(" · ")
    }
}

pub(crate) struct ProjectList {
    pub(crate) all: Arc<Vec<Project>>,
    pub(crate) selected: Option<String>,
    index: Option<IndexPath>,
}
impl ProjectList {
    pub(crate) fn new() -> Self {
        Self {
            all: Arc::new(Vec::new()),
            selected: None,
            index: None,
        }
    }
    pub(crate) fn at(&self, ix: IndexPath) -> Option<&Project> {
        self.all.get(ix.row)
    }
}
impl ListDelegate for ProjectList {
    type Item = ListItem;
    fn items_count(&self, _: usize, _: &App) -> usize {
        self.all.len()
    }
    fn render_item(
        &mut self,
        ix: IndexPath,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<ListItem> {
        let p = self.at(ix)?;
        Some(
            ListItem::new(SharedString::from(format!("project-{}", p.id)))
                .confirmed(self.selected.as_ref() == Some(&p.id))
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_size(px(crate::appearance::TextRole::BODY))
                        .text_color(cx.theme().foreground)
                        .child(SharedString::from(p.name.clone())),
                ),
        )
    }
    fn set_selected_index(
        &mut self,
        ix: Option<IndexPath>,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) {
        self.index = ix;
        cx.notify();
    }
    fn perform_search(
        &mut self,
        _: &str,
        _: &mut Window,
        _: &mut Context<ListState<Self>>,
    ) -> Task<()> {
        Task::ready(())
    }
    fn render_empty(
        &mut self,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> impl IntoElement {
        div()
            .text_xs()
            .text_color(cx.theme().muted_foreground)
            .child("No configured projects")
    }
}

pub(crate) struct Overview {
    scroll: gpui_kit::ScrollHandle,
    projects: Arc<Vec<Project>>,
    chats: Arc<Vec<Chat>>,
    project: Option<String>,
    projects_loaded: bool,
    chats_loaded: bool,
    error: Option<&'static str>,
    totals: Counts,
    counts: BTreeMap<String, Counts>,
    project_rows: Vec<usize>,
    working: Vec<usize>,
    visible: Vec<usize>,
    #[cfg(feature = "native-probes")]
    pub(crate) renders: u64,
}
impl EventEmitter<ShellEvent> for Overview {}
impl Overview {
    pub(crate) fn new() -> Self {
        Self {
            scroll: gpui_kit::ScrollHandle::default(),
            projects: Arc::new(Vec::new()),
            chats: Arc::new(Vec::new()),
            project: None,
            projects_loaded: false,
            chats_loaded: false,
            error: None,
            totals: Counts::default(),
            counts: BTreeMap::new(),
            project_rows: Vec::new(),
            working: Vec::new(),
            visible: Vec::new(),
            #[cfg(feature = "native-probes")]
            renders: 0,
        }
    }
    pub(crate) fn sync(&mut self, input: OverviewInput, cx: &mut Context<Self>) {
        let OverviewInput {
            projects,
            chats,
            project,
            projects_loaded,
            chats_loaded,
            error,
        } = input;
        if Arc::ptr_eq(&projects, &self.projects)
            && Arc::ptr_eq(&chats, &self.chats)
            && self.project == project
            && self.projects_loaded == projects_loaded
            && self.chats_loaded == chats_loaded
            && self.error == error
        {
            return;
        }
        self.projects = projects;
        self.chats = chats;
        self.project = project;
        self.projects_loaded = projects_loaded;
        self.chats_loaded = chats_loaded;
        self.error = error;
        self.totals = Counts::default();
        self.counts.clear();
        self.working.clear();
        self.visible.clear();
        for (ix, chat) in self
            .chats
            .iter()
            .enumerate()
            .filter(|(_, c)| !c.archived && !c.local_draft)
        {
            self.totals.add(chat);
            if let Some(id) = &chat.project_id {
                self.counts.entry(id.clone()).or_default().add(chat);
            }
            if self
                .project
                .as_ref()
                .is_none_or(|p| chat.project_id.as_ref() == Some(p))
            {
                if self.visible.len() < 12 {
                    self.visible.push(ix);
                }
                if self.working.len() < 5 && chat.signal == Some(crate::dither::Signal::Working) {
                    self.working.push(ix);
                }
            }
        }
        self.project_rows = (0..self.projects.len()).collect();
        self.project_rows.sort_by_key(|ix| {
            let c = self
                .counts
                .get(&self.projects[*ix].id)
                .copied()
                .unwrap_or_default();
            (
                if c.attention > 0 {
                    0
                } else if c.ready > 0 {
                    1
                } else if c.working > 0 {
                    2
                } else {
                    3
                },
                self.projects[*ix].name.to_lowercase(),
                self.projects[*ix].id.clone(),
            )
        });
        self.project_rows.truncate(8);
        cx.notify();
    }
    fn chat_row(&self, ix: usize, prefix: &str, cx: &mut Context<Self>) -> impl IntoElement {
        let chat = &self.chats[ix];
        let id = chat.id.clone();
        Button::new(SharedString::from(format!("{prefix}-{id}")))
            .ghost()
            .small()
            .w_full()
            .justify_start()
            .min_w_0()
            .overflow_hidden()
            .accessibility_label(SharedString::from(format!(
                "{} · {}",
                chat.title,
                chat.signal_label()
            )))
            .h(px(crate::appearance::Space::ROW))
            .rounded(px(crate::appearance::Radius::ROW))
            .child(
                div()
                    .v_flex()
                    .w_full()
                    .min_w_0()
                    .gap(px(crate::appearance::Space::META))
                    .child(
                        div()
                            .truncate()
                            .text_size(px(crate::appearance::TextRole::BODY))
                            .child(SharedString::from(chat.title.clone())),
                    )
                    .child(
                        div()
                            .truncate()
                            .text_size(px(crate::appearance::TextRole::CAPTION))
                            .text_color(cx.theme().muted_foreground)
                            .child(SharedString::from(chat.signal_label().to_owned())),
                    ),
            )
            .on_click(cx.listener(move |_, _, _, cx| cx.emit(ShellEvent::Chat(id.clone()))))
    }
    pub(crate) fn scroll_position(&self) -> f32 {
        f32::from(self.scroll.offset().y)
    }
    pub(crate) fn restore_scroll(&mut self, y: f32, cx: &mut Context<Self>) {
        self.scroll
            .set_offset(gpui_kit::point(px(0.), px(crate::navigation::offset(y))));
        cx.notify();
    }
}
impl Overview {
    fn heading(&self, id: &'static str, title: &'static str) -> impl IntoElement {
        div()
            .id(id)
            .test_support()
            .text_size(px(crate::appearance::TextRole::HEADLINE))
            .font_semibold()
            .child(title)
    }
    fn projects_section(&self, w: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        use crate::appearance::{Space, TextRole};
        let mut section = div()
            .v_flex()
            .gap(px(Space::CONTROL))
            .child(self.heading("home-projects-heading", "Projects"));
        if self.projects.is_empty() {
            section = section.child(
                div()
                    .text_size(px(TextRole::BODY))
                    .text_color(cx.theme().muted_foreground)
                    .child(if !self.projects_loaded {
                        "Loading Local projects…"
                    } else {
                        "No projects configured. Existing chats remain in All chats."
                    }),
            );
        }
        for ix in &self.project_rows {
            let p = &self.projects[*ix];
            let id = p.id.clone();
            let counts = self.counts.get(&id).copied().unwrap_or_default();
            section = section.child(
                Button::new(SharedString::from(format!("home-project-{id}")))
                    .ghost()
                    .small()
                    .w_full()
                    .min_w_0()
                    .justify_start()
                    .overflow_hidden()
                    .h(px(Space::ROW))
                    .rounded(px(crate::appearance::Radius::ROW))
                    .border_b(crate::appearance::hairline(w))
                    .border_color(cx.theme().border)
                    .accessibility_label(SharedString::from(format!(
                        "{} · {}",
                        p.name,
                        counts.line()
                    )))
                    .child(
                        div()
                            .v_flex()
                            .w_full()
                            .min_w_0()
                            .gap(px(Space::META))
                            .child(
                                div()
                                    .id(SharedString::from(format!("overview-project-title-{id}")))
                                    .test_support()
                                    .w_full()
                                    .min_w_0()
                                    .truncate()
                                    .text_size(px(TextRole::BODY))
                                    .font_medium()
                                    .child(SharedString::from(p.name.clone())),
                            )
                            .child(
                                div()
                                    .w_full()
                                    .min_w_0()
                                    .truncate()
                                    .text_size(px(TextRole::CAPTION))
                                    .text_color(cx.theme().muted_foreground)
                                    .child(SharedString::from(if self.chats_loaded {
                                        counts.line()
                                    } else {
                                        "Loading chat activity…".into()
                                    })),
                            ),
                    )
                    .on_click(
                        cx.listener(move |_, _, _, cx| cx.emit(ShellEvent::Project(id.clone()))),
                    ),
            );
        }
        if self.projects.len() > 8 {
            section = section.child(
                div()
                    .text_size(px(TextRole::CAPTION))
                    .text_color(cx.theme().muted_foreground)
                    .child("All projects are available from the sidebar scope chooser."),
            );
        }
        section
    }
    fn chat_section(&self, w: &Window, working: bool, cx: &mut Context<Self>) -> impl IntoElement {
        use crate::appearance::{Space, TextRole};
        let (id, title, prefix, rows) = if working {
            (
                "home-working-heading",
                "Working now",
                "home-working",
                &self.working,
            )
        } else {
            (
                "home-recent-heading",
                "Recent chats",
                "home-chat",
                &self.visible,
            )
        };
        let mut section = div()
            .v_flex()
            .gap(px(Space::CONTROL))
            .child(self.heading(id, title));
        if rows.is_empty() {
            section = section.child(
                div()
                    .text_size(px(TextRole::BODY))
                    .text_color(cx.theme().muted_foreground)
                    .child(if !self.chats_loaded {
                        "Loading Local chats…"
                    } else if working {
                        "No working chats in this view."
                    } else {
                        "No loaded chats in this view."
                    }),
            );
        }
        for ix in rows {
            section = section.child(
                div()
                    .border_b(crate::appearance::hairline(w))
                    .border_color(cx.theme().border)
                    .child(self.chat_row(*ix, prefix, cx)),
            );
        }
        section
    }
}
impl Render for Overview {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        use crate::appearance::{Space, TextRole};
        #[cfg(feature = "native-probes")]
        {
            self.renders += 1;
        }
        let project = self
            .project
            .as_ref()
            .and_then(|id| self.projects.iter().find(|p| &p.id == id));
        let title = project
            .map(|p| p.name.as_str())
            .unwrap_or(if self.project.is_some() {
                "Project unavailable"
            } else {
                "Home"
            });
        let counts = self
            .project
            .as_ref()
            .map(|id| self.counts.get(id).copied().unwrap_or_default())
            .unwrap_or(self.totals);
        let mut header = div().v_flex().gap(px(Space::META)).child(
            div()
                .id("overview-title")
                .test_support()
                .truncate()
                .text_size(px(if self.project.is_none() {
                    TextRole::DISPLAY
                } else {
                    TextRole::TITLE
                }))
                .font_semibold()
                .child(SharedString::from(title.to_owned())),
        );
        if let Some(p) = project {
            header = header.child(
                div()
                    .truncate()
                    .text_size(px(TextRole::CAPTION))
                    .text_color(cx.theme().muted_foreground)
                    .child(SharedString::from(p.path.clone())),
            );
        }
        if self.project.is_none() {
            header = header.child(
                div()
                    .text_size(px(TextRole::LABEL))
                    .text_color(cx.theme().muted_foreground)
                    .child("Across all projects"),
            );
        }
        header = header
            .child(
                div()
                    .id("home-loaded-qualifier")
                    .test_support()
                    .text_size(px(TextRole::CAPTION))
                    .text_color(cx.theme().muted_foreground)
                    .child("Local · loaded chat summaries only"),
            )
            .child(
                div()
                    .truncate()
                    .text_size(px(TextRole::BODY))
                    .text_color(cx.theme().muted_foreground)
                    .child(if self.chats_loaded {
                        counts.line()
                    } else {
                        "Loading Local chats…".into()
                    }),
            );
        if let Some(error) = self.error {
            header = header.child(
                div()
                    .truncate()
                    .text_size(px(TextRole::BODY))
                    .text_color(cx.theme().danger)
                    .child(error),
            );
        }
        let mut body = div()
            .v_flex()
            .gap(px(Space::SECTION))
            .p(px(Space::HOME))
            .w_full()
            .min_w_0()
            .max_w(px(760.))
            .mx_auto()
            .child(header);
        if self.project.is_some() && project.is_none() {
            body=body.child(div().text_size(px(TextRole::BODY)).child(if self.projects_loaded {"This project is not in the current catalog. Its folder and chats are unchanged."}else{"Waiting for the Local project catalog…"}));
        } else {
            if self.project.is_none() {
                body = body.child(self.projects_section(w, cx));
            }
            body = body
                .child(self.chat_section(w, true, cx))
                .child(self.chat_section(w, false, cx));
        }
        body=body.child(Button::new("home-all-chats").ghost().small().self_start().label("All chats").on_click(cx.listener(|_,_,_,cx|cx.emit(ShellEvent::AllChats))))
            .child(div().text_size(px(TextRole::CAPTION)).text_color(cx.theme().muted_foreground).child("Loaded Local activity, not full dashboard totals. Full Inbox, missions and project settings remain available in Swift."));
        div()
            .v_flex()
            .size_full()
            .min_h_0()
            .min_w_0()
            .overflow_y_scrollbar()
            .id("overview-scroll")
            .with_scroll_handle(&self.scroll)
            .child(body)
    }
}
#[cfg(test)]
mod workbench_tests {
    use super::*;
    #[test]
    fn counts_name_loaded_scope_and_omit_quiet_zero_activity() {
        assert_eq!(Counts::default().line(), "0 loaded chats");
        assert_eq!(
            Counts {
                chats: 1,
                ..Default::default()
            }
            .line(),
            "1 loaded chat"
        );
        assert_eq!(
            Counts {
                chats: 4,
                working: 1,
                attention: 2,
                ready: 0
            }
            .line(),
            "4 loaded chats · 1 working · 2 need you"
        );
        assert_eq!(
            Counts {
                chats: 3,
                ready: 1,
                ..Default::default()
            }
            .line(),
            "3 loaded chats · 1 ready to merge"
        );
    }
}
