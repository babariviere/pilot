//! Project pages in the Settings window. The owner outlives the window, keyed by exact project ID,
//! so drafts survive closing Settings and switching projects. Only explicit Save writes.
use crate::{
    LocalOptions,
    local_model::Project,
    project_settings::{Editor, Outcome, Status, name_problem},
    ui::{self, Action, FieldLayout, FieldRow, Notice, Text, Tone},
};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::{
    App, AppContext, Context, Div, Entity, EntityInputHandler, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, Styled, Subscription, Task, TestSupportExt, Window,
    component::{
        ActiveTheme, Disableable, StyledExt,
        checkbox::Checkbox,
        input::{Input, InputState},
    },
    div, px,
};
use std::{collections::HashMap, sync::Arc};

struct Page {
    editor: Editor,
    name: Option<Entity<InputState>>,
    /// The editor's `replaced` count the name field last loaded.
    name_loaded: u64,
    _name_events: Option<Subscription>,
    reply: Option<Task<()>>,
}

pub(crate) struct ProjectSettings {
    options: Option<LocalOptions>,
    pub(crate) catalog: Arc<Vec<Project>>,
    pages: HashMap<String, Page>,
    pub(crate) selected: Option<String>,
}
impl ProjectSettings {
    pub(crate) fn new(options: Option<LocalOptions>) -> Self {
        Self {
            options,
            catalog: Arc::new(Vec::new()),
            pages: HashMap::new(),
            selected: None,
        }
    }
    pub(crate) fn catalog(&mut self, projects: Arc<Vec<Project>>, cx: &mut Context<Self>) {
        if Arc::ptr_eq(&self.catalog, &projects) {
            return;
        }
        self.catalog = projects;
        for page in self.pages.values_mut() {
            page.editor.catalog(&self.catalog);
        }
        cx.notify();
    }
    pub(crate) fn select(&mut self, project_id: String, cx: &mut Context<Self>) {
        if self.selected.as_deref() != Some(&project_id) {
            if !self.pages.contains_key(&project_id)
                && let Some(project) = self.catalog.iter().find(|p| p.id == project_id)
            {
                self.pages.insert(
                    project_id.clone(),
                    Page {
                        editor: Editor::new(project),
                        name: None,
                        name_loaded: 0,
                        _name_events: None,
                        reply: None,
                    },
                );
            }
            self.selected = Some(project_id);
            cx.notify();
        }
    }
    #[cfg(any(test, feature = "native-probes"))]
    pub(crate) fn editor(&self, project_id: &str) -> Option<&Editor> {
        self.pages.get(project_id).map(|p| &p.editor)
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn name_for_probe(&self, project_id: &str) -> Option<Entity<InputState>> {
        self.pages.get(project_id)?.name.clone()
    }
    fn selected_page(&mut self) -> Option<&mut Page> {
        self.pages.get_mut(self.selected.as_deref()?)
    }
    /// The first project page that holds unsaved or unsettled work, by name.
    pub(crate) fn unsettled(&self) -> Option<String> {
        self.pages
            .values()
            .filter(|p| p.editor.unsettled())
            .map(|p| page_title(&p.editor))
            .min()
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) fn update_hold(&self) -> Option<crate::update_hold::Hold> {
        let sending = self.pages.values().any(|p| p.editor.saving());
        let unsaved = self.pages.values().any(|p| p.editor.dirty());
        crate::update_hold::Hold::of(sending, unsaved)
    }
    pub(crate) fn name_marked(&self, window: &mut Window, cx: &mut App) -> bool {
        self.pages.values().any(|p| {
            p.name
                .as_ref()
                .is_some_and(|n| n.update(cx, |i, cx| i.marked_text_range(window, cx).is_some()))
        })
    }

    pub(crate) fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.name_marked(window, cx) {
            return;
        }
        let options = self.options.clone();
        let Some(page) = self.selected_page() else {
            return;
        };
        let Some(submission) = page.editor.begin_save() else {
            return;
        };
        let started = match options {
            Some(options) => crate::project_settings_transport::start(options, submission.clone()),
            None => Err("Preview only. Project settings can't be saved here."),
        };
        match started {
            Err(reason) => {
                page.editor.finish(&submission, Outcome::NotSent(reason));
            }
            Ok(rx) => {
                let id = submission.project_id.clone();
                page.reply = Some(cx.spawn(async move |owner, cx| {
                    if let Ok((submission, outcome)) = rx.recv().await {
                        let _ = owner.update(cx, |owner, cx| {
                            if let Some(page) = owner.pages.get_mut(&id)
                                && page.editor.finish(&submission, outcome)
                            {
                                cx.notify();
                            }
                        });
                    }
                }));
            }
        }
        cx.notify();
    }
    pub(crate) fn revert(&mut self, cx: &mut Context<Self>) {
        if let Some(page) = self.selected_page()
            && page.editor.revert()
        {
            cx.notify();
        }
    }
    fn edit(&mut self, f: impl FnOnce(&mut Editor) -> bool, cx: &mut Context<Self>) {
        if let Some(page) = self.selected_page()
            && f(&mut page.editor)
        {
            cx.notify();
        }
    }

    /// The name field, created in the window that shows it. It reloads only when the form's
    /// draft is replaced (Revert, a daemon update, a save), never while the user types.
    fn name_input(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Entity<InputState>> {
        let id = self.selected.clone()?;
        let page = self.pages.get_mut(&id)?;
        let draft = page.editor.draft().name.clone();
        if let Some(input) = &page.name {
            let input = input.clone();
            if page.name_loaded != page.editor.replaced()
                && !input.update(cx, |i, cx| i.marked_text_range(window, cx).is_some())
            {
                page.name_loaded = page.editor.replaced();
                input.update(cx, |i, cx| i.set_value(draft, window, cx));
            }
            return Some(input);
        }
        let input = cx.new(|cx| {
            let mut i = InputState::new(window, cx);
            i.set_value(draft, window, cx);
            i
        });
        // Observe rather than wait for Change: IME and programmatic edits notify too.
        page._name_events = Some(cx.observe(&input, move |owner, input, cx| {
            let value = input.read(cx).value().to_string();
            if let Some(page) = owner.pages.get_mut(&id)
                && page.editor.set_name(&value)
            {
                cx.notify();
            }
        }));
        page.name = Some(input.clone());
        page.name_loaded = page.editor.replaced();
        Some(input)
    }

    /// Save bar for the selected project; None when there is nothing to decide.
    pub(crate) fn footer(this: &Entity<Self>, close_notice: bool, cx: &App) -> Option<Div> {
        let owner = this.read(cx);
        let editor = &owner.pages.get(owner.selected.as_deref()?)?.editor;
        let failed = match editor.status() {
            Status::Failed(reason) => Some((*reason, Tone::Error)),
            Status::Unknown(reason) => Some((*reason, Tone::Warning)),
            _ => None,
        };
        let dirty = editor.dirty();
        let saving = editor.saving();
        if !dirty && !saving && failed.is_none() {
            return None;
        }
        let status = if saving {
            "Saving…"
        } else if dirty {
            "Unsaved changes"
        } else {
            ""
        };
        let can_save =
            dirty && !saving && !editor.removed() && name_problem(&editor.draft().name).is_none();
        let (revert, save) = (this.clone(), this.clone());
        Some(
            div()
                .v_flex()
                .gap_3()
                .when(!status.is_empty(), |d| {
                    d.child(
                        ui::text(Text::Caption, status)
                            .id("project-settings-status")
                            .test_support()
                            .text_color(cx.theme().muted_foreground),
                    )
                })
                .when(editor.updated_elsewhere() && dirty, |d| {
                    d.child(
                        Notice::new("This project changed elsewhere.")
                            .detail("Saving applies only the fields you changed. Revert to load the new values.")
                            .tone(Tone::Warning),
                    )
                })
                .when_some(failed, |d, (reason, tone)| d.child(Notice::new(reason).tone(tone)))
                .when(close_notice && dirty, |d| {
                    d.child(
                        Notice::new("Save or revert your project changes before closing.")
                            .tone(Tone::Warning),
                    )
                })
                .child(
                    div()
                        .h_flex()
                        .flex_wrap()
                        .gap_2()
                        .child(
                            ui::action("project-settings-revert", "Revert", Action::Secondary)
                                .disabled(saving || (!dirty && failed.is_none()))
                                .on_click(move |_, _, cx| revert.update(cx, |o, cx| o.revert(cx))),
                        )
                        .child(
                            ui::action("project-settings-save", "Save changes", Action::Primary)
                                .loading(saving)
                                .disabled(!can_save)
                                .tooltip("Save project changes (⌘S)")
                                .on_click(move |_, window, cx| {
                                    save.update(cx, |o, cx| o.save(window, cx))
                                }),
                        ),
                ),
        )
    }
}

fn page_title(editor: &Editor) -> String {
    editor.known().name.clone()
}

fn section(id: &'static str, title: &'static str) -> impl IntoElement {
    ui::heading(id, title, Text::Headline)
}

/// A value the user can read but not change here, with where it is changed instead.
fn readonly(value: impl IntoElement, note: &'static str, cx: &App) -> Div {
    div()
        .v_flex()
        .min_w_0()
        .gap(px(ui::Space::META))
        .child(value)
        .child(ui::text(Text::Caption, note).text_color(cx.theme().muted_foreground))
}

fn toggle(
    id: &'static str,
    label: &'static str,
    detail: &'static str,
    checked: bool,
    disabled: bool,
    on_change: impl Fn(bool, &mut App) + 'static,
    cx: &App,
) -> Div {
    // The caption sits in the checkbox's own label column, aligned with the label.
    div().child(
        Checkbox::new(id)
            .label(label)
            .checked(checked)
            .disabled(disabled)
            .on_click(move |checked, _, cx| on_change(*checked, cx))
            .child(ui::text(Text::Caption, detail).text_color(cx.theme().muted_foreground)),
    )
}

impl Render for ProjectSettings {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(id) = self.selected.clone() else {
            return div()
                .child(Notice::new("Choose a project."))
                .into_any_element();
        };
        let name = self.name_input(window, cx);
        let Some(page) = self.pages.get(&id) else {
            return div()
                .v_flex()
                .gap(px(ui::Space::SECTION))
                .child(ui::header("settings-page-title", "Project", Text::Title))
                .child(
                    Notice::new("This project is no longer available.")
                        .detail("It was removed from Pilot. Choose another project.")
                        .tone(Tone::Warning),
                )
                .into_any_element();
        };
        let editor = &page.editor;
        let removed = editor.removed();
        let disabled = !editor.editable();
        let draft = editor.draft().clone();
        let title: SharedString = page_title(editor).into();
        let path: SharedString = editor.known().path.clone().into();
        let wide = window.viewport_size().width > px(800.);
        let layout = if wide {
            FieldLayout::Inline
        } else {
            FieldLayout::Stacked
        };
        let this = cx.entity();
        let invalid = editor.dirty().then(|| name_problem(&draft.name)).flatten();
        let widens = editor
            .latest()
            .is_some_and(|p| p.policy.require_pull_request)
            && !draft.require_pull_request;
        let name_row = FieldRow::new(
            "project-settings-name",
            "Name",
            name.map(|n| {
                Input::new(&n)
                    .aria_label("Project name")
                    .disabled(disabled)
                    .into_any_element()
            })
            .unwrap_or_else(|| div().into_any_element()),
        )
        .layout(layout)
        .when_some(invalid, |r, p| r.validation(p, Tone::Error));
        div()
            .id("project-settings")
            .test_support()
            .v_flex()
            .gap(px(ui::Space::SECTION))
            .child(
                div()
                    .v_flex()
                    .gap(px(ui::Space::META))
                    .child(ui::header("settings-page-title", title, Text::Title))
                    .child(
                        ui::text(Text::Caption, path.clone())
                            .id("project-settings-path-subtitle")
                            .test_support()
                            .truncate()
                            .text_color(cx.theme().muted_foreground),
                    ),
            )
            .when(removed, |d| {
                d.child(
                    Notice::new("This project was removed.")
                        .detail("Its settings can no longer be saved. Revert to clear your edits.")
                        .tone(Tone::Warning),
                )
            })
            .child(
                div()
                    .v_flex()
                    .gap_4()
                    .child(section("project-settings-general", "General"))
                    .child(name_row)
                    .child(
                        FieldRow::new(
                            "project-settings-folder",
                            "Folder",
                            readonly(
                                ui::text(Text::Body, path.clone())
                                    .id("project-settings-path")
                                    .test_support()
                                    .min_w_0()
                                    .truncate(),
                                "Add a new project to use a different folder.",
                                cx,
                            ),
                        )
                        .layout(layout),
                    )
                    .child(
                        FieldRow::new(
                            "project-settings-branch",
                            "Default branch",
                            readonly(
                                ui::text(Text::Body, "The origin remote's default branch")
                                    .id("project-settings-branch-value")
                                    .test_support(),
                                "Set on the remote, not per project.",
                                cx,
                            ),
                        )
                        .layout(layout),
                    ),
            )
            .child(
                div()
                    .v_flex()
                    .gap_4()
                    .child(section("project-settings-workspace", "Workspace"))
                    .child(toggle(
                        "project-settings-isolated",
                        "Isolated workspace per chat",
                        "Each chat works in its own copy, so it never touches your folder. When off, chats run in the folder itself.",
                        draft.isolated,
                        disabled,
                        {
                            let this = this.clone();
                            move |on, cx| this.update(cx, |o, cx| o.edit(|e| e.set_isolated(on), cx))
                        },
                        cx,
                    ))
                    .child(toggle(
                        "project-settings-pull-request",
                        "Require a pull request",
                        "Agents publish changes through a pull request. Applies when a chat next starts working.",
                        draft.require_pull_request,
                        disabled,
                        move |on, cx| {
                            this.update(cx, |o, cx| o.edit(|e| e.set_require_pull_request(on), cx))
                        },
                        cx,
                    ))
                    .when(widens, |d| {
                        d.child(
                            Notice::new("Agents will be allowed to push directly to the default branch.")
                                .tone(Tone::Warning),
                        )
                    }),
            )
            .into_any_element()
    }
}

#[cfg(test)]
#[path = "project_settings_view_tests.rs"]
mod tests;
