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
    NewChat,
    AddProject,
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
        use crate::state_mark::Signal;
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

/// The sidebar's project picker: All projects, then your folders (with how
/// many projects each holds), then every project.
pub(crate) struct ProjectList {
    pub(crate) all: Arc<Vec<Project>>,
    pub(crate) empty_label: &'static str,
    pub(crate) selected: Option<String>,
    /// Your folders and their project counts, and the folder scope.
    pub(crate) folders: Vec<(String, usize)>,
    pub(crate) folder: Option<String>,
    index: Option<IndexPath>,
}
/// A picker row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ScopeChoice {
    All,
    Folder(String),
    Project(String),
}
/// Picker sections: All projects, Folders, Projects.
const SCOPE_ALL: usize = 0;
const SCOPE_FOLDERS: usize = 1;
pub(crate) const SCOPE_PROJECTS: usize = 2;
const SCOPE_ROW: f32 = 28.;
const SCOPE_HEADER: f32 = 24.;
impl ProjectList {
    pub(crate) fn new() -> Self {
        Self {
            all: Arc::new(Vec::new()),
            empty_label: "Loading projects…",
            selected: None,
            folders: Vec::new(),
            folder: None,
            index: None,
        }
    }
    pub(crate) fn at(&self, ix: IndexPath) -> Option<&Project> {
        (ix.section == SCOPE_PROJECTS).then(|| self.all.get(ix.row))?
    }
    pub(crate) fn choice(&self, ix: IndexPath) -> Option<ScopeChoice> {
        match ix.section {
            SCOPE_ALL => (ix.row == 0 && !self.all.is_empty()).then_some(ScopeChoice::All),
            SCOPE_FOLDERS => self
                .folders
                .get(ix.row)
                .map(|(name, _)| ScopeChoice::Folder(name.clone())),
            _ => self.at(ix).map(|p| ScopeChoice::Project(p.id.clone())),
        }
    }
    /// Where the current scope is in the list.
    pub(crate) fn current(&self) -> Option<IndexPath> {
        if self.all.is_empty() {
            return None;
        }
        if let Some(id) = &self.selected {
            return self
                .all
                .iter()
                .position(|p| &p.id == id)
                .map(|row| IndexPath::new(row).section(SCOPE_PROJECTS));
        }
        if let Some(folder) = &self.folder {
            return self
                .folders
                .iter()
                .position(|(name, _)| name == folder)
                .map(|row| IndexPath::new(row).section(SCOPE_FOLDERS));
        }
        Some(IndexPath::new(0).section(SCOPE_ALL))
    }
    fn headers(&self) -> bool {
        !self.folders.is_empty() && !self.all.is_empty()
    }
    /// The height its rows need.
    pub(crate) fn content_height(&self) -> f32 {
        if self.all.is_empty() {
            return SCOPE_ROW;
        }
        let rows = 1 + self.folders.len() + self.all.len();
        rows as f32 * SCOPE_ROW
            + if self.headers() {
                2. * SCOPE_HEADER
            } else {
                0.
            }
    }
}
impl ListDelegate for ProjectList {
    type Item = ListItem;
    fn sections_count(&self, _: &App) -> usize {
        3
    }
    fn items_count(&self, section: usize, _: &App) -> usize {
        if self.all.is_empty() {
            return 0;
        }
        match section {
            SCOPE_ALL => 1,
            SCOPE_FOLDERS => self.folders.len(),
            _ => self.all.len(),
        }
    }
    fn item_height(&self, _: IndexPath, _: &App) -> Option<gpui_kit::Pixels> {
        Some(px(SCOPE_ROW))
    }
    fn section_header_height(&self, section: usize, _: &App) -> Option<gpui_kit::Pixels> {
        Some(px(if section != SCOPE_ALL && self.headers() {
            SCOPE_HEADER
        } else {
            0.
        }))
    }
    fn render_section_header(
        &mut self,
        section: usize,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<impl IntoElement> {
        (section != SCOPE_ALL && self.headers()).then(|| {
            div()
                .id(SharedString::from(format!("scope-section-{section}")))
                .test_support()
                .h(px(SCOPE_HEADER))
                .h_flex()
                .items_end()
                .px_2()
                .pb_1()
                .text_size(px(crate::appearance::TextRole::CAPTION))
                .font_semibold()
                .text_color(cx.theme().muted_foreground)
                .child(if section == SCOPE_FOLDERS {
                    "Folders"
                } else {
                    "Projects"
                })
        })
    }
    fn render_item(
        &mut self,
        ix: IndexPath,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<ListItem> {
        let (id, name, icon, count, chosen) = match self.choice(ix)? {
            ScopeChoice::All => (
                "scope-all".to_owned(),
                "All projects".to_owned(),
                AppIcon::Projects,
                None,
                self.selected.is_none() && self.folder.is_none(),
            ),
            ScopeChoice::Folder(name) => (
                format!("scope-folder-{name}"),
                name.clone(),
                AppIcon::Projects,
                self.folders.get(ix.row).map(|(_, n)| *n),
                self.selected.is_none() && self.folder.as_ref() == Some(&name),
            ),
            ScopeChoice::Project(id) => {
                let p = self.at(ix)?;
                (
                    format!("project-{id}"),
                    p.name.clone(),
                    AppIcon::Project,
                    None,
                    self.selected.as_ref() == Some(&id),
                )
            }
        };
        let spoken = match count {
            Some(n) => format!(
                "{name} · folder · {n} project{}",
                if n == 1 { "" } else { "s" }
            ),
            None => name.clone(),
        };
        Some(
            ListItem::new(SharedString::from(id))
                .px_2()
                .py_0()
                .min_h_8()
                .accessibility_label(SharedString::from(spoken))
                .confirmed(chosen)
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
                                .child(icon.icon()),
                        )
                        .child(
                            div()
                                .id("scope-project-title")
                                .test_support()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .child(SharedString::from(name)),
                        )
                        .children(count.map(|n| {
                            div()
                                .id("scope-folder-count")
                                .test_support()
                                .flex_none()
                                .text_size(px(crate::appearance::TextRole::CAPTION))
                                .text_color(cx.theme().muted_foreground)
                                .child(SharedString::from(n.to_string()))
                        })),
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
    subscriptions: Vec<crate::provider_usage::Snapshot>,
    pub(crate) limits: Option<gpui_kit::Entity<crate::provider_refresh_view::Limits>>,
    /// Providers whose Home subscription details are expanded, by stable provider key.
    subscription_details: Vec<&'static str>,
    sky: std::rc::Rc<std::cell::RefCell<crate::home_sky::Sky>>,
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
            sky: Default::default(),
            subscriptions: Vec::new(),
            limits: None,
            subscription_details: Vec::new(),
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
        let mut subscriptions = crate::provider_usage::newest(&chats);
        // A failed, empty update keeps the last usable windows beside its error, with their own report time.
        for s in subscriptions
            .iter_mut()
            .filter(|s| s.update_error && s.windows.is_empty())
        {
            if let Some(prior) = self
                .subscriptions
                .iter()
                .find(|p| p.provider == s.provider && !p.windows.is_empty())
            {
                s.windows = prior.windows.clone();
                s.fetched_at = prior.fetched_at;
            }
        }
        self.subscriptions = subscriptions;
        if let Some(limits) = &self.limits {
            limits.update(cx, |v, cx| v.sync(self.subscriptions.clone(), cx));
        }
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
                if self.working.len() < 5 && chat.signal == Some(crate::state_mark::Signal::Working)
                {
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
        let label = SharedString::from(match chat.pause_reason() {
            Some(reason) => format!("{} · {detail} · {reason}", chat.title),
            None => format!("{} · {detail}", chat.title),
        });
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
                        "Loading projects…"
                    } else {
                        "No projects yet. Add a folder to group its chats."
                    }),
            );
            if self.projects_loaded {
                section = section.child(
                    crate::ui::action(
                        "home-add-project",
                        "Add project…",
                        crate::ui::Action::Secondary,
                    )
                    .self_start()
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(ShellEvent::AddProject))),
                );
            }
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
                    .child("Choose any project from the sidebar."),
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
                        "Loading chats…"
                    } else if working {
                        "Nothing is running."
                    } else if self.project.is_some() {
                        "No chats in this project yet."
                    } else {
                        "No chats yet."
                    }),
            );
            // An empty Home leads to its one primary action.
            if !working && self.chats_loaded && self.chats.is_empty() {
                section = section.child(
                    crate::ui::action("home-new-chat", "New chat", crate::ui::Action::Primary)
                        .self_start()
                        .on_click(cx.listener(|_, _, _, cx| cx.emit(ShellEvent::NewChat))),
                );
            }
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
                        "Counts cover the chats loaded in this window.",
                    )
                    .build(w, cx)
                })
                .child(if self.chats_loaded {
                    counts.line()
                } else {
                    "Loading chats…".into()
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
        // Swift parity: compact subscription bars sit under Home's summary, never on a project.
        if let Some(limits) = self.limits.clone().filter(|_| self.project.is_none()) {
            header = header.child(limits);
        } else if self.project.is_none() {
            let toggle = |provider: &'static str| -> crate::provider_usage_view::Toggle {
                Box::new(
                    cx.listener(move |v: &mut Self, _: &gpui_kit::ClickEvent, _, cx| {
                        if let Some(ix) = v.subscription_details.iter().position(|p| *p == provider)
                        {
                            v.subscription_details.remove(ix);
                        } else {
                            v.subscription_details.push(provider);
                        }
                        cx.notify();
                    }),
                )
            };
            header = header.children(crate::provider_usage_view::section(
                &self.subscriptions,
                &self.subscription_details,
                crate::usage_overview::now(),
                toggle,
                cx,
            ));
        }
        let mut body = crate::ui::page().child(header);
        if self.project.is_some() && project.is_none() {
            body = body.child(
                div()
                    .text_size(px(TextRole::BODY))
                    .child(if self.projects_loaded {
                        "This project is no longer listed. Its folder and chats are unchanged."
                    } else {
                        "Loading projects…"
                    }),
            );
        } else {
            if self.project.is_none() {
                body = body.child(self.projects_section(w, cx));
            }
            body = body
                .child(self.chat_section(w, true, cx))
                .child(self.chat_section(w, false, cx));
        }
        body = body.child(
            crate::ui::action("home-all-chats", "All chats", crate::ui::Action::Quiet)
                .self_start()
                .on_click(cx.listener(|_, _, _, cx| cx.emit(ShellEvent::AllChats))),
        );
        // Home (all projects) opens under its dithered sky; the title sits in its foot.
        let home = self.project.is_none();
        let mut page = div().relative().w_full();
        if home {
            page = page.child(
                div()
                    .id("home-sky")
                    .absolute()
                    .top_0()
                    .left_0()
                    .w_full()
                    .child(crate::home_sky::element(
                        self.sky.clone(),
                        cx.theme().is_dark(),
                    )),
            );
            // Title in the sparse last dots; the count line below the band stays clear.
            body = body.pt(px(crate::home_sky::HEIGHT - 40.));
        }
        let page = page.child(body);
        div()
            .v_flex()
            .size_full()
            .min_h_0()
            .min_w_0()
            .overflow_y_scrollbar()
            .id("overview-scroll")
            .with_scroll_handle(&self.scroll)
            .child(page)
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
                ..Default::default()
            },
            Project {
                id: "ab".into(),
                name: "Boreal".into(),
                path: "/synthetic/shared".into(),
                ..Default::default()
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
        chat.signal = Some(crate::state_mark::Signal::Working);
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
        assert_eq!(
            chat_row_detail(&chat, &projects, false),
            "",
            "plain idle says nothing"
        );
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
