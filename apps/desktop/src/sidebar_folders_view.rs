//! Project folders in the sidebar: the folder scope chosen in the project
//! picker, a section's folder from its menu, and the Edit folders dialog. All
//! of it is your own sidebar memory on this machine; nothing is sent to Local.
use super::*;
use crate::{
    appearance::TextRole,
    local_model::Project,
    navigation::{Location, Target},
    sidebar_folders::{self, Folders},
    ui::{self, Action, Notice, Tone},
};
use gpui_kit::{
    EntityInputHandler, Focusable, StatefulInteractiveElement as _, WeakEntity,
    component::{
        WindowExt,
        input::{Input, InputState},
        menu::{DropdownMenu, PopupMenuItem},
    },
};

impl LocalViewer {
    /// Collapse or expand a project section, keeping the selection on a
    /// visible row: the selected row, else the section's label.
    pub(super) fn toggle_sidebar_group(
        &mut self,
        key: &str,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.chats.update(cx, |list, cx| {
            let selected = list
                .delegate()
                .selected
                .and_then(|ix| list.delegate().key_at(ix));
            let collapsed = !list.delegate().memory.group_collapsed(key);
            list.delegate_mut().set_group_collapsed(key, collapsed);
            let ix = selected.and_then(|id| {
                list.delegate()
                    .index(&id)
                    .or_else(|| list.delegate().index(&format!("group:{key}")))
            });
            list.set_selected_index(ix, w, cx);
            cx.notify();
        });
        self.save_sidebar_memory(cx);
    }
    /// Apply edited folders: rows, the picker and the scope follow at once.
    pub(super) fn set_folders(&mut self, folders: Folders, w: &mut Window, cx: &mut Context<Self>) {
        self.chats.update(cx, |list, cx| {
            let selected = list
                .delegate()
                .selected
                .and_then(|ix| list.delegate().key_at(ix));
            let d = list.delegate_mut();
            if d.folder.as_ref().is_some_and(|f| !folders.contains(f)) {
                d.folder = None;
            }
            d.memory.set_folders(folders);
            d.filter();
            let ix = selected.and_then(|id| list.delegate().index(&id));
            list.set_selected_index(ix, w, cx);
            cx.notify();
        });
        self.save_sidebar_memory(cx);
        self.rebuild_nav(w, cx);
        cx.notify();
    }
    /// File a project in a folder, or unfile it.
    pub(super) fn file_project(
        &mut self,
        project: &str,
        folder: Option<String>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mut folders = self.chats.read(cx).delegate().memory.folders().clone();
        folders.assign(project, folder.as_deref());
        self.set_folders(folders, w, cx);
    }
    /// The picker's All projects and folder choices. A folder narrows the
    /// sidebar across all projects; it is not a navigation scope of its own.
    pub(super) fn choose_folder(
        &mut self,
        folder: Option<String>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.project_scope.is_some() && !self.focus_all(w, cx) {
            return;
        }
        self.chats.update(cx, |list, cx| {
            let selected = list
                .delegate()
                .selected
                .and_then(|ix| list.delegate().key_at(ix));
            list.delegate_mut().folder = folder;
            list.delegate_mut().filter();
            let ix = selected.and_then(|id| list.delegate().index(&id));
            list.set_selected_index(ix, w, cx);
            cx.notify();
        });
        self.projects_open = false;
        self.rebuild_nav(w, cx);
        self.chats.update(cx, |l, cx| l.focus(w, cx));
        cx.notify();
    }
    /// Leave a project scope for all projects, back where you last were there.
    fn focus_all(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        if !self.prepare_navigation(w, cx) {
            return false;
        }
        let saved = self.scope_states.get(&None).and_then(|s| s.target.clone());
        let mut location = Location {
            scope: None,
            target: saved.unwrap_or(Target::Home),
        };
        if matches!(self.page, Page::Inbox(_)) {
            location.target = Target::Inbox(None);
        }
        if !self.can_restore(&location, cx) {
            location.target = Target::Home;
        }
        if !self.restore_location(&location, w, cx) {
            return false;
        }
        self.did_navigate(cx);
        true
    }
    pub(super) fn open_folder_editor(
        &mut self,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Entity<FolderEditor>> {
        let memory = &self.chats.read(cx).delegate().memory;
        if !memory.loaded() {
            return None;
        }
        let folders = memory.folders().clone();
        let projects = self.state.projects.clone();
        let owner = cx.entity().downgrade();
        self.projects_open = false;
        let form = cx.new(|cx| FolderEditor::new(owner, folders, projects, w, cx));
        FolderEditor::open(form.clone(), w, cx);
        cx.notify();
        Some(form)
    }
}

/// Edit folders: add, rename and remove folders and file projects in them.
/// Changes apply together on Save; Cancel or Escape keeps the saved folders.
pub(crate) struct FolderEditor {
    owner: WeakEntity<LocalViewer>,
    saved: Folders,
    pub(crate) draft: Folders,
    projects: Arc<Vec<Project>>,
    /// One name field per folder in `draft.names`, same order.
    pub(crate) names: Vec<Entity<InputState>>,
    pub(crate) new_name: Entity<InputState>,
    _events: Vec<Subscription>,
}
impl FolderEditor {
    fn new(
        owner: WeakEntity<LocalViewer>,
        folders: Folders,
        projects: Arc<Vec<Project>>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let new_name = cx.new(|cx| InputState::new(w, cx).placeholder("New folder"));
        let events = vec![cx.observe(&new_name, |_, _, cx| cx.notify())];
        let mut editor = Self {
            owner,
            saved: folders.clone(),
            draft: folders.clone(),
            projects,
            names: Vec::new(),
            new_name,
            _events: events,
        };
        for name in &folders.names {
            editor.push_name(name, w, cx);
        }
        editor
    }
    fn push_name(&mut self, name: &str, w: &mut Window, cx: &mut Context<Self>) {
        let input = cx.new(|cx| {
            let mut i = InputState::new(w, cx);
            i.set_value(name.to_owned(), w, cx);
            i
        });
        self._events
            .push(cx.observe(&input, |_, _, cx| cx.notify()));
        self.names.push(input);
    }
    /// The folders as edited, or why they can't be saved.
    pub(crate) fn result(&self, cx: &App) -> Result<Folders, &'static str> {
        let mut folders = self.draft.clone();
        for (old, input) in self.draft.names.iter().zip(&self.names) {
            let new = input.read(cx).value();
            if sidebar_folders::clean(&new).as_deref() != Some(old.as_str())
                && !folders.rename(old, &new)
            {
                return Err("Each folder needs its own name.");
            }
        }
        Ok(folders)
    }
    fn marked(&self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        std::iter::once(&self.new_name)
            .chain(&self.names)
            .any(|i| i.update(cx, |i, cx| i.marked_text_range(w, cx).is_some()))
    }
    fn add(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.marked(w, cx) {
            return;
        }
        let name = self.new_name.read(cx).value().to_string();
        let Some(name) = self.draft.add(&name) else {
            return;
        };
        self.push_name(&name, w, cx);
        self.new_name.update(cx, |i, cx| i.set_value("", w, cx));
        cx.notify();
    }
    fn remove(&mut self, ix: usize, cx: &mut Context<Self>) {
        let Some(name) = self.draft.names.get(ix).cloned() else {
            return;
        };
        self.draft.remove(&name);
        self.names.remove(ix);
        cx.notify();
    }
    pub(crate) fn assign(&mut self, project: &str, folder: Option<String>, cx: &mut Context<Self>) {
        self.draft.assign(project, folder.as_deref());
        cx.notify();
    }
    fn save(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.marked(w, cx) {
            return;
        }
        let Ok(folders) = self.result(cx) else {
            return;
        };
        let _ = self.owner.update(cx, |v, cx| v.set_folders(folders, w, cx));
        w.close_dialog(cx);
    }
    pub(crate) fn open(form: Entity<Self>, w: &mut Window, cx: &mut App) {
        let cancel = form.clone();
        let input = form.read(cx).new_name.clone();
        w.open_dialog(cx, move |dialog, _, cx| {
            ui::dialog(dialog, cx)
                .title("Folders")
                .w(px(400.))
                .overlay_closable(false)
                .close_button(false)
                .keyboard(false)
                .on_cancel({
                    let cancel = cancel.clone();
                    move |_, w, cx| cancel.update(cx, |v, cx| !v.marked(w, cx))
                })
                .child(form.clone())
        });
        input.focus_handle(cx).focus(w, cx);
    }
    /// A folder's live name, for the project choices.
    fn label(&self, ix: usize, cx: &App) -> String {
        sidebar_folders::clean(&self.names[ix].read(cx).value())
            .unwrap_or_else(|| self.draft.names[ix].clone())
    }
}
impl Render for FolderEditor {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let result = self.result(cx);
        let dirty = result.as_ref().is_ok_and(|f| f != &self.saved);
        let can_add = sidebar_folders::clean(&self.new_name.read(cx).value()).is_some_and(|n| {
            !self
                .draft
                .names
                .iter()
                .any(|f| f.to_lowercase() == n.to_lowercase())
        });
        let muted = cx.theme().muted_foreground;
        let folder_rows = self.names.iter().enumerate().map(|(ix, input)| {
            div()
                .id(SharedString::from(format!("folder-row-{ix}")))
                .test_support()
                .h_flex()
                .items_center()
                .gap_1()
                .child(
                    div().flex_1().min_w_0().child(
                        Input::new(input)
                            .id(SharedString::from(format!("folder-name-{ix}")))
                            .aria_label("Folder name")
                            .small(),
                    ),
                )
                .child(
                    ui::icon_action(
                        SharedString::from(format!("folder-remove-{ix}")),
                        "Remove folder",
                        crate::app_icon::AppIcon::Delete,
                        Action::Quiet,
                    )
                    .tooltip("Remove folder (its projects stay)")
                    .on_click(cx.listener(move |v, _, _, cx| v.remove(ix, cx))),
                )
        });
        let choices: Vec<String> = (0..self.names.len()).map(|ix| self.label(ix, cx)).collect();
        let project_rows = self.projects.iter().map(|p| {
            let current = self
                .draft
                .folder_of(&p.id)
                .and_then(|f| self.draft.names.iter().position(|n| n == f));
            let editor = cx.entity().downgrade();
            let (names, id, choices) = (self.draft.names.clone(), p.id.clone(), choices.clone());
            div()
                .id(SharedString::from(format!("folder-project-{}", p.id)))
                .test_support()
                .h_flex()
                .items_center()
                .gap_2()
                .min_h_8()
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(TextRole::BODY))
                        .child(SharedString::from(p.name.clone())),
                )
                .child(
                    Button::new(SharedString::from(format!("folder-choice-{}", p.id)))
                        .ghost()
                        .small()
                        .flex_shrink_0()
                        .max_w(px(180.))
                        .accessibility_label(SharedString::from(format!("Folder for {}", p.name)))
                        .child(
                            div()
                                .h_flex()
                                .items_center()
                                .gap_1()
                                .min_w_0()
                                .text_color(if current.is_some() {
                                    cx.theme().foreground
                                } else {
                                    muted
                                })
                                .child(div().min_w_0().truncate().child(
                                    SharedString::from(
                                        current.map_or("No folder".to_owned(), |ix| {
                                            choices[ix].clone()
                                        }),
                                    ),
                                ))
                                .child(
                                    gpui_kit::component::Icon::new(IconName::ChevronDown)
                                        .size_3()
                                        .flex_none(),
                                ),
                        )
                        .dropdown_menu(move |mut menu, _, _| {
                            for (ix, name) in names.iter().enumerate() {
                                let (editor, id, name) = (editor.clone(), id.clone(), name.clone());
                                menu = menu.item(
                                    PopupMenuItem::new(SharedString::from(choices[ix].clone()))
                                        .checked(current == Some(ix))
                                        .on_click(move |_, _, cx| {
                                            let _ = editor.update(cx, |v, cx| {
                                                v.assign(&id, Some(name.clone()), cx)
                                            });
                                        }),
                                );
                            }
                            let (editor, id) = (editor.clone(), id.clone());
                            menu.item(
                                PopupMenuItem::new("No folder")
                                    .checked(current.is_none())
                                    .on_click(move |_, _, cx| {
                                        let _ = editor.update(cx, |v, cx| v.assign(&id, None, cx));
                                    }),
                            )
                        }),
                )
        });
        div()
            .id("folder-editor")
            .test_support()
            .v_flex()
            .gap_3()
            .min_w_0()
            .capture_action(cx.listener(|v, _: &gpui_kit::base::input::Enter, w, cx| {
                if v.new_name.focus_handle(cx).is_focused(w) {
                    v.add(w, cx);
                    cx.stop_propagation();
                } else if v.names.iter().any(|i| i.focus_handle(cx).is_focused(w)) {
                    v.save(w, cx);
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|v, _: &gpui_kit::base::input::Escape, w, cx| {
                if !v.marked(w, cx) {
                    w.close_dialog(cx);
                }
                cx.stop_propagation();
            }))
            .child(
                div().v_flex().gap_1().children(folder_rows).child(
                    div()
                        .h_flex()
                        .items_center()
                        .gap_1()
                        .child(
                            div().flex_1().min_w_0().child(
                                Input::new(&self.new_name)
                                    .id("folder-new-name")
                                    .aria_label("New folder name")
                                    .small(),
                            ),
                        )
                        .child(
                            ui::action("folder-add", "Add", Action::Secondary)
                                .disabled(!can_add)
                                .on_click(cx.listener(|v, _, w, cx| v.add(w, cx))),
                        ),
                ),
            )
            .when(!self.projects.is_empty(), |d| {
                d.child(
                    div()
                        .v_flex()
                        .gap_1()
                        .child(ui::text(ui::Text::Caption, "Projects").text_color(muted))
                        .child(
                            div()
                                .id("folder-projects")
                                .v_flex()
                                .max_h(px(260.))
                                .overflow_y_scroll()
                                .test_support()
                                .children(project_rows),
                        ),
                )
            })
            .when_some(result.err(), |d, error| {
                d.child(Notice::new(error).tone(Tone::Warning))
            })
            .child(
                div()
                    .h_flex()
                    .justify_end()
                    .gap_2()
                    .child(
                        ui::action("folder-cancel", "Cancel", Action::Secondary).on_click(
                            cx.listener(|v, _, w, cx| {
                                if !v.marked(w, cx) {
                                    w.close_dialog(cx);
                                }
                            }),
                        ),
                    )
                    .child(
                        ui::action("folder-save", "Save", Action::Primary)
                            .disabled(!dirty)
                            .on_click(cx.listener(|v, _, w, cx| v.save(w, cx))),
                    ),
            )
    }
}
