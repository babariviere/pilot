//! Bounded Local app-shell projections. No I/O, authority or canonical writes.
use crate::app_icon::AppIcon;
use crate::local_model::{Chat, Project};
use gpui_kit::{
    App, Context, EventEmitter, InteractiveElement, IntoElement, ParentElement, Render,
    SharedString, StatefulInteractiveElement, Styled, Task, TestSupportExt, Window,
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
    Missions,
    Mission(crate::mission_browser::Key),
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

/// Display-only context shared by the project row's text, tooltip and label.
/// An unloaded activity projection is not a confirmed zero count.
fn project_row_context(
    project: &Project,
    counts: Counts,
    chats_loaded: bool,
) -> (SharedString, SharedString) {
    let detail = if chats_loaded {
        counts.line()
    } else {
        "Loading chat activity…".into()
    };
    let label = SharedString::from(format!("{} · {detail}", project.name));
    (detail.into(), label)
}

pub(crate) struct ProjectList {
    pub(crate) all: Arc<Vec<Project>>,
    pub(crate) empty_label: &'static str,
    pub(crate) selected: Option<String>,
    index: Option<IndexPath>,
}
impl ProjectList {
    pub(crate) fn new() -> Self {
        Self {
            all: Arc::new(Vec::new()),
            empty_label: "Loading Local projects…",
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
                .px_2()
                .py_0()
                .min_h_8()
                .accessibility_label(SharedString::from(p.name.clone()))
                .confirmed(self.selected.as_ref() == Some(&p.id))
                .child(
                    div()
                        .h_flex()
                        .w_full()
                        .min_w_0()
                        .gap_2()
                        .items_center()
                        .text_size(px(crate::appearance::TextRole::BODY))
                        .text_color(cx.theme().foreground)
                        .child(
                            div()
                                .id("scope-project-icon")
                                .test_support()
                                .size_4()
                                .flex_shrink_0()
                                .child(AppIcon::Project.icon()),
                        )
                        .child(
                            div()
                                .id("scope-project-title")
                                .test_support()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .child(SharedString::from(p.name.clone())),
                        ),
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
            .px_2()
            .py_1()
            .text_size(px(crate::appearance::TextRole::BODY))
            .text_color(cx.theme().muted_foreground)
            .child(self.empty_label)
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
/// Loaded public row context only. Never infer ownership from a shared folder.
/// Work is bounded by the existing visible-row and project-catalog limits.
fn chat_row_detail(chat: &Chat, projects: &[Project], include_project: bool) -> String {
    let reason = chat.row_reason();
    if !include_project {
        return reason.unwrap_or_default().to_owned();
    }
    let project = chat
        .project_id
        .as_ref()
        .map(|id| {
            projects
                .iter()
                .find(|p| &p.id == id)
                .map(|p| p.name.as_str())
                .unwrap_or("Project unavailable")
        })
        .unwrap_or("No project");
    match reason {
        Some(reason) => format!("{project} · {reason}"),
        None => project.to_owned(),
    }
}
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
        let detail = chat_row_detail(chat, &self.projects, self.project.is_none());
        let label = SharedString::from(format!("{} · {detail}", chat.title));
        Button::new(SharedString::from(format!("{prefix}-{id}")))
            .ghost()
            .small()
            .w_full()
            .justify_start()
            .min_w_0()
            .overflow_hidden()
            .accessibility_label(label.clone())
            .tooltip(label)
            .h(px(crate::appearance::Space::ROW))
            .rounded(px(crate::appearance::Radius::ROW))
            .child(
                crate::ui::ResourceLabel::new(SharedString::from(chat.title.clone()))
                    .detail(SharedString::from(detail)),
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
        crate::ui::heading(id, title, crate::ui::Text::Headline)
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
            let (detail, label) = project_row_context(p, counts, self.chats_loaded);
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
                    .accessibility_label(label.clone())
                    .tooltip(label)
                    .child(
                        crate::ui::ResourceLabel::new(SharedString::from(p.name.clone()))
                            .detail(detail)
                            .icon(crate::ui::IconRole::Project),
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
        // Working chats appear once, under Working now.
        let rows: Vec<usize> = rows
            .iter()
            .copied()
            .filter(|ix| working || !self.working.contains(ix))
            .collect();
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
        for ix in &rows {
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
        use crate::appearance::TextRole;
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
        let mut header = crate::ui::header(
            "overview-title",
            SharedString::from(title.to_owned()),
            if self.project.is_none() {
                crate::ui::Text::Display
            } else {
                crate::ui::Text::Title
            },
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
        // One count line; its coverage caveat lives in the tooltip.
        header = header.child(
            div()
                .id("home-loaded-qualifier")
                .truncate()
                .text_size(px(TextRole::BODY))
                .text_color(cx.theme().muted_foreground)
                .tooltip(|w, cx| {
                    gpui_kit::component::tooltip::Tooltip::new(
                        "Loaded Local chat summaries, not full dashboard totals.",
                    )
                    .build(w, cx)
                })
                .child(if self.chats_loaded {
                    counts.line()
                } else {
                    "Loading Local chats…".into()
                })
                .test_support(),
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
        let mut body = crate::ui::page().child(header);
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
        body=body.child(crate::ui::action("home-all-chats", "All chats", crate::ui::Action::Quiet).self_start().on_click(cx.listener(|_,_,_,cx|cx.emit(ShellEvent::AllChats))));
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
    use serde_json::json;
    fn context_projects() -> Vec<Project> {
        vec![
            Project {
                id: "a".into(),
                name: "Atlas".into(),
                path: "/synthetic/shared".into(),
            },
            Project {
                id: "ab".into(),
                name: "Boreal".into(),
                path: "/synthetic/shared".into(),
            },
        ]
    }
    #[test]
    fn project_context_never_turns_loading_into_zero_and_preserves_full_text() {
        let project = Project {
            name: "Long synthetic project 日本語 👩‍💻 e\u{301} ".repeat(20),
            ..context_projects().remove(0)
        };
        let counts = Counts {
            chats: 4,
            working: 1,
            attention: 2,
            ready: 1,
        };
        for counts in [Counts::default(), counts] {
            let (detail, label) = project_row_context(&project, counts, false);
            assert_eq!(detail.as_ref(), "Loading chat activity…");
            assert_eq!(
                label.as_ref(),
                format!("{} · Loading chat activity…", project.name)
            );
            assert!(!label.contains("loaded chat"));
        }
        let (detail, label) = project_row_context(&project, counts, true);
        assert_eq!(
            detail.as_ref(),
            "4 loaded chats · 1 working · 2 need you · 1 ready to merge"
        );
        assert_eq!(label.as_ref(), format!("{} · {detail}", project.name));
        assert_eq!(
            project_row_context(&project, Counts::default(), true)
                .0
                .as_ref(),
            "0 loaded chats"
        );
    }
    #[gpui_kit::test]
    fn shared_project_rows_preserve_geometry_and_exact_keyboard_pointer_events(
        cx: &mut gpui_kit::TestAppContext,
    ) {
        use gpui_kit::{
            AppContext, Bounds, WindowBounds, WindowOptions,
            component::{Theme, ThemeMode},
            size,
            test::TestWindowExt,
        };
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init_appearance(cx);
        });
        for width in [496., 868.] {
            for mode in [ThemeMode::Light, ThemeMode::Dark] {
                for loaded in [false, true] {
                    cx.update(|cx| Theme::change(mode, None, cx));
                    let mut projects = context_projects();
                    for p in &mut projects {
                        p.name
                            .push_str(&" 日本語 👩‍💻 long synthetic project".repeat(20));
                    }
                    let chats = Arc::new(vec![crate::local_model::chat(&json!({"id":"canonical-ab","title":"Synthetic work","projectId":"ab","cwd":"/synthetic/shared","state":"working"})).unwrap()]);
                    let (h, v) = cx.update(|cx| {
                        gpui_kit::open_window(
                            WindowOptions {
                                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                    Default::default(),
                                    size(px(width), px(1000.)),
                                ))),
                                show: false,
                                focus: false,
                                ..Default::default()
                            },
                            cx,
                            |_, cx| {
                                cx.new(|cx| {
                                    let mut v = Overview::new();
                                    v.sync(
                                        OverviewInput {
                                            projects: Arc::new(projects),
                                            chats,
                                            project: None,
                                            projects_loaded: true,
                                            chats_loaded: loaded,
                                            error: None,
                                        },
                                        cx,
                                    );
                                    v
                                })
                            },
                        )
                        .unwrap()
                    });
                    let events = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
                    let recorded = events.clone();
                    let _subscription = cx.update(|cx| {
                        cx.subscribe(&v, move |_, event: &ShellEvent, _| {
                            if let ShellEvent::Project(id) = event {
                                recorded.borrow_mut().push(id.clone());
                            }
                        })
                    });
                    cx.run_until_parked();
                    cx.update_window(h, |_, w, cx| {
                        w.draw(cx).clear(cx);
                        for id in ["a", "ab"] {
                            let owner = format!("home-project-{id}");
                            let row = w.find(owner.clone()).bounds();
                            let title = w.within(owner.clone()).find("resource-title").bounds();
                            let detail = w.within(owner.clone()).find("resource-detail").bounds();
                            let icon = w.within(owner).find("resource-icon").bounds();
                            assert_eq!(row.size.height, px(crate::appearance::Space::ROW));
                            assert_eq!(icon.size, size(w.rem_size(), w.rem_size()));
                            assert!(
                                icon.left() >= row.left()
                                    && icon.left() - row.left()
                                        < px(crate::appearance::Space::SIDEBAR)
                            );
                            assert!(
                                (title.left()
                                    - icon.right()
                                    - px(crate::appearance::Space::CONTROL))
                                .abs()
                                    < px(0.1)
                            );
                            assert_eq!(title.left(), detail.left());
                            assert!(title.right() <= row.right() && detail.right() <= row.right());
                            assert!(title.top() >= row.top() && detail.bottom() <= row.bottom());
                        }
                        w.focus_next(cx);
                        w.press("space", cx);
                    })
                    .unwrap();
                    cx.run_until_parked();
                    assert_eq!(
                        &*events.borrow(),
                        &["ab".to_string()],
                        "native keyboard activates exact first ranked project, not same-folder a"
                    );
                    cx.update_window(h, |_, w, cx| w.click("home-project-a", cx))
                        .unwrap();
                    cx.run_until_parked();
                    assert_eq!(&*events.borrow(), &["ab".to_string(), "a".to_string()]);
                    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
                    cx.run_until_parked();
                }
            }
        }
    }
    #[test]
    fn row_context_uses_exact_project_and_public_reason_not_the_shared_folder() {
        let projects = context_projects();
        let mut chat=crate::local_model::chat(&json!({"id":"c","title":"synthetic","projectId":"ab","cwd":"/synthetic/shared","state":"idle","outcome":"question","attentionReason":{"kind":"asks","detail":"Choose 日本語 👩‍💻 region"}})).unwrap();
        assert_eq!(
            chat_row_detail(&chat, &projects, true),
            "Boreal · Asks: Choose 日本語 👩‍💻 region"
        );
        assert_eq!(
            chat_row_detail(&chat, &projects, false),
            "Asks: Choose 日本語 👩‍💻 region"
        );
        for id in ["absent", "A"] {
            chat.project_id = Some(id.into());
            assert!(chat_row_detail(&chat, &projects, true).starts_with("Project unavailable · "));
        }
        chat.project_id = None;
        assert!(chat_row_detail(&chat, &projects, true).starts_with("No project · "));
        chat.attention = None;
        chat.signal = Some(crate::dither::Signal::Working);
        chat.background_work = true;
        assert_eq!(
            chat_row_detail(&chat, &projects, false),
            "Working in background"
        );
        chat.signal = None;
        chat.state = "stopped".into();
        assert_eq!(
            chat_row_detail(&chat, &projects, false),
            chat.signal_label(),
            "unknown/quiet fallback is not an invented completion"
        );
        chat.state = "idle".into();
        assert_eq!(chat_row_detail(&chat, &projects, false), "", "plain idle says nothing");
    }
    #[gpui_kit::test]
    fn home_row_context_preserves_mounted_frame_and_exact_pointer_activation(
        cx: &mut gpui_kit::TestAppContext,
    ) {
        use gpui_kit::{
            AppContext, Bounds, WindowBounds, WindowOptions, size, test::TestWindowExt,
        };
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init_appearance(cx);
        });
        for width in [496., 868.] {
            let projects = Arc::new(context_projects());
            let chats=Arc::new(vec![crate::local_model::chat(&json!({"id":"canonical-ab","title":"A long synthetic row 日本語 ".repeat(16),"projectId":"ab","state":"idle","attentionReason":{"kind":"asks","detail":"Keep this question attached to its exact chat"}})).unwrap()]);
            let (h, v) = cx.update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(1000.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |_, cx| {
                        cx.new(|cx| {
                            let mut v = Overview::new();
                            v.sync(
                                OverviewInput {
                                    projects,
                                    chats,
                                    project: None,
                                    projects_loaded: true,
                                    chats_loaded: true,
                                    error: None,
                                },
                                cx,
                            );
                            v
                        })
                    },
                )
                .unwrap()
            });
            let events = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
            let recorded = events.clone();
            let _subscription = cx.update(|cx| {
                cx.subscribe(&v, move |_, event: &ShellEvent, _| {
                    if let ShellEvent::Chat(id) = event {
                        recorded.borrow_mut().push(id.clone());
                    }
                })
            });
            cx.run_until_parked();
            cx.update_window(h, |_, w, cx| {
                w.draw(cx).clear(cx);
                let row = w.find("home-chat-canonical-ab").bounds();
                let title = w
                    .within("home-chat-canonical-ab")
                    .find("resource-title")
                    .bounds();
                let detail = w
                    .within("home-chat-canonical-ab")
                    .find("resource-detail")
                    .bounds();
                assert_eq!(row.size.height, px(crate::appearance::Space::ROW));
                assert!(title.size.width > px(0.) && detail.size.width > px(0.));
                assert_eq!(title.left(), detail.left());
                assert!(
                    title.left() >= row.left()
                        && title.left() - row.left() < px(crate::appearance::Space::SIDEBAR)
                );
                assert!(title.right() <= row.right() && detail.right() <= row.right());
                assert!(
                    w.within("home-chat-canonical-ab")
                        .try_find("resource-icon")
                        .is_none()
                );
                w.click("home-chat-canonical-ab", cx);
            })
            .unwrap();
            cx.run_until_parked();
            assert_eq!(&*events.borrow(), &["canonical-ab".to_string()]);
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
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
