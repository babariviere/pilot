//! Explicit folder -> confirmation -> one registration. No chat/draft adoption.
use crate::{
    delivery_store::Book,
    interaction::{Interaction, WriteCommand, WriteState},
    project_registration::{Outcome, validate_path},
    ui::{self, Action, Notice, Text, Tone},
};
use gpui_kit::{
    Context, EventEmitter, FocusHandle, InteractiveElement, IntoElement, ParentElement, Render,
    SharedString, StatefulInteractiveElement, Styled, TestSupportExt, Window,
    base::FocusTrapElement,
    component::{Disableable, StyledExt},
    div,
};
use std::{path::PathBuf, sync::Arc};

gpui_kit::actions!(project_add, [ConfirmProject, CancelProject]);
pub(crate) struct Closed;
pub(crate) struct ProjectAdd {
    client: Option<Interaction>,
    focus: FocusHandle,
    pub(crate) open: bool,
    epoch: u64,
    pub(crate) path: Option<String>,
    pub(crate) choosing: bool,
    pub(crate) pending: bool,
    pub(crate) result: Option<Result<Outcome, &'static str>>,
    request: String,
    book: Option<Arc<Book>>,
    state_error: Option<&'static str>,
    navigation_error: Option<&'static str>,
    catalog_error: Option<&'static str>,
    receipt: Option<(String, String)>,
    #[cfg(any(test, feature = "native-probes"))]
    pub(crate) folders: Option<std::collections::VecDeque<Result<Option<PathBuf>, &'static str>>>,
}
impl EventEmitter<Closed> for ProjectAdd {}
impl ProjectAdd {
    pub(crate) fn new(client: Option<Interaction>, cx: &mut Context<Self>) -> Self {
        Self {
            client,
            focus: cx.focus_handle(),
            open: false,
            epoch: 0,
            path: None,
            choosing: false,
            pending: false,
            result: None,
            request: String::new(),
            book: None,
            state_error: None,
            navigation_error: None,
            catalog_error: None,
            receipt: None,
            #[cfg(any(test, feature = "native-probes"))]
            folders: None,
        }
    }
    pub(crate) fn has_context(&self) -> bool {
        self.receipt.is_some()
            || self
                .book
                .as_ref()
                .is_some_and(|b| !b.project_registrations.is_empty())
    }
    pub(crate) fn open(
        &mut self,
        issue: Option<&'static str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open = true;
        self.navigation_error = issue;
        self.epoch += 1;
        self.choosing = false;
        self.focus.focus(window, cx);
        cx.notify();
    }
    pub(crate) fn close(&mut self, cx: &mut Context<Self>) {
        self.open = false;
        self.epoch += 1;
        self.choosing = false;
        // Network requests belong to the durable worker, not sheet lifetime.
        cx.emit(Closed);
        cx.notify();
    }
    pub(crate) fn accept(&mut self, state: &WriteState, cx: &mut Context<Self>) {
        self.book = state.book.clone();
        self.state_error = state.error;
        if let Some(receipt) = &state.project_receipt {
            self.receipt = Some(receipt.clone());
        }
        if let Some(reply) = &state.project
            && reply.id == self.request
        {
            self.pending = matches!(reply.result, Ok(Outcome::Pending));
            self.result = Some(reply.result.clone());
            if let Some(catalog) = &reply.catalog {
                self.catalog_error = catalog.as_ref().err().copied();
            }
        }
        if self.state_error.is_some() {
            self.pending = false;
        }
        cx.notify();
    }
    fn mutable(&self) -> bool {
        self.client.is_some()
            && self.book.is_some()
            && self.state_error.is_none()
            && self.navigation_error.is_none()
            && !self.pending
            && !self.choosing
    }
    fn attempt(&self) -> Option<&crate::project_registration::Attempt> {
        self.book
            .as_ref()?
            .project_registrations
            .values()
            .find(|a| Some(&a.path) == self.path.as_ref())
    }
    pub(crate) fn choose(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.open || !self.mutable() {
            return;
        }
        self.epoch += 1;
        let epoch = self.epoch;
        self.choosing = true;
        cx.notify();
        #[cfg(any(test, feature = "native-probes"))]
        if let Some(folders) = &mut self.folders {
            let value = folders.pop_front().unwrap_or(Ok(None));
            self.chosen(epoch, value, cx);
            return;
        }
        let response = cx.prompt_for_paths(gpui_kit::PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Choose project folder".into()),
        });
        cx.spawn_in(window, async move |view, cx| {
            let result = match response.await {
                Ok(Ok(None)) => Ok(None),
                Ok(Ok(Some(mut paths))) if paths.len() == 1 => Ok(paths.pop()),
                _ => Err("Folder selection failed. No project registration was sent."),
            };
            let _ = view.update(cx, |view, cx| view.chosen(epoch, result, cx));
        })
        .detach();
    }
    fn chosen(
        &mut self,
        epoch: u64,
        value: Result<Option<PathBuf>, &'static str>,
        cx: &mut Context<Self>,
    ) {
        if !self.open || epoch != self.epoch {
            return;
        }
        self.choosing = false;
        match value {
            Ok(None) => {} // Cancellation does not mutate the selected path or send HTTP.
            Err(error) => self.result = Some(Err(error)),
            Ok(Some(path)) => match path
                .to_str()
                .ok_or("Folder path is not valid Unicode.")
                .and_then(|s| validate_path(s).map(|_| s.to_owned()))
            {
                Ok(path) => {
                    self.path = Some(path);
                    self.result = None;
                    self.request.clear();
                }
                Err(error) => self.result = Some(Err(error)),
            },
        }
        cx.notify();
    }
    pub(crate) fn confirm(&mut self, cx: &mut Context<Self>) {
        if !self.open || !self.mutable() || self.attempt().is_some() || self.path.is_none() {
            return;
        }
        self.send(self.path.clone(), cx);
    }
    pub(crate) fn refresh(&mut self, cx: &mut Context<Self>) {
        if !self.open || !self.mutable() {
            return;
        }
        self.send(None, cx);
    }
    fn send(&mut self, path: Option<String>, cx: &mut Context<Self>) {
        let id = uuid::Uuid::new_v4().to_string();
        if self.client.as_ref().is_some_and(|c| {
            c.command(WriteCommand::Project {
                id: id.clone(),
                path,
            })
        }) {
            self.request = id;
            self.pending = true;
            self.result = Some(Ok(Outcome::Pending));
        } else {
            self.result = Some(Err(
                "Can't add projects right now. Nothing was sent; close and try again.",
            ));
        }
        cx.notify();
    }
    fn known(&self) -> Option<&str> {
        self.attempt()
            .and_then(|a| a.created.as_deref())
            .or_else(|| {
                self.receipt
                    .as_ref()
                    .filter(|(id, _)| {
                        id == &self.request || self.attempt().is_some_and(|a| &a.id == id)
                    })
                    .map(|(_, id)| id.as_str())
            })
    }
    fn private_receipt_unconfirmed(&self) -> bool {
        self.known().is_some_and(|id| {
            self.attempt()
                .is_none_or(|a| a.created.as_deref() != Some(id))
        })
    }
    fn known_detail(&self) -> String {
        format!(
            "Choose it from the project list.{}{}{}",
            if self.private_receipt_unconfirmed() {
                " This window couldn't record it, so don't add it again."
            } else {
                ""
            },
            self.state_error.map_or(String::new(), |e| format!(" {e}")),
            self.catalog_error.map_or(String::new(), |e| format!(
                " Couldn't refresh projects: {e}"
            ))
        )
    }
    fn notice(&self) -> Notice {
        if self.known().is_some() {
            return Notice::new("Project added.")
                .detail(SharedString::from(self.known_detail()))
                .tone(
                    if self.private_receipt_unconfirmed() || self.state_error.is_some() {
                        Tone::Warning
                    } else {
                        Tone::Success
                    },
                );
        }
        if let Some(error) = self.state_error {
            return Notice::new(error).tone(Tone::Error);
        }
        if let Some(error) = self.navigation_error {
            return Notice::new(error).tone(Tone::Error);
        }
        if let Some(error) = self.catalog_error {
            return Notice::new(error)
                .detail("Showing the last list of projects.")
                .tone(Tone::Error);
        }
        if self.choosing {
            return Notice::new("Choosing a folder…").tone(Tone::Quiet);
        }
        if self.pending {
            return Notice::new("Adding project…")
                .detail("Closing won't cancel or resend it.")
                .tone(Tone::Quiet);
        }
        if self.attempt().is_some() {
            let title = match &self.result {
                Some(Ok(Outcome::Unknown(reason))) => *reason,
                _ => "Couldn't confirm the project was added. Don't add this folder again.",
            };
            return Notice::new(title)
                .detail("Refresh projects to check whether it appears.")
                .tone(Tone::Warning);
        }
        match &self.result {
            Some(Err(error)) => Notice::new(*error).tone(Tone::Error),
            Some(Ok(Outcome::Unknown(reason))) => Notice::new(*reason).tone(Tone::Warning),
            Some(Ok(Outcome::Read)) => Notice::new("Project list refreshed.").tone(Tone::Quiet),
            _ => Notice::new("Nothing is copied and no chat starts.").tone(Tone::Quiet),
        }
    }
}
impl Render for ProjectAdd {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let enabled = self.mutable();
        let confirm = enabled && self.path.is_some() && self.attempt().is_none();
        // Refresh helps only once there is something to check.
        let refresh = self.attempt().is_some()
            || self.catalog_error.is_some()
            || matches!(
                self.result,
                Some(Ok(Outcome::Unknown(_)) | Ok(Outcome::Read))
            );
        div()
            .id("add-project-form")
            .test_support()
            .track_focus(&self.focus)
            .key_context("AddProject")
            .v_flex()
            .size_full()
            .min_h_0()
            .gap_3()
            .capture_action(cx.listener(|v, _: &gpui_kit::base::input::Escape, _, cx| {
                v.close(cx);
                cx.stop_propagation();
            }))
            .on_action(cx.listener(|v, _: &CancelProject, _, cx| {
                v.close(cx);
                cx.stop_propagation();
            }))
            .on_action(cx.listener(|v, _: &ConfirmProject, _, cx| {
                v.confirm(cx);
                cx.stop_propagation();
            }))
            .child(ui::header("add-project-title", "Add project", Text::Title))
            .child(
                div()
                    .id("add-project-body")
                    .test_support()
                    .v_flex()
                    .flex_1()
                    .min_h_0()
                    .gap_3()
                    .overflow_y_scroll()
                    .child(ui::text(
                        Text::Body,
                        "Choose a folder on this Mac to add it as a project.",
                    ))
                    .child(
                        ui::action("choose-project-folder", "Choose folder…", Action::Secondary)
                            .disabled(!enabled)
                            .on_click(cx.listener(|v, _, w, cx| v.choose(w, cx))),
                    )
                    .child(
                        div()
                            .id("project-folder-path")
                            .test_support()
                            .min_w_0()
                            .child(ui::text(
                                Text::Body,
                                SharedString::from(
                                    self.path.clone().unwrap_or("No folder chosen".into()),
                                ),
                            )),
                    )
                    .child(self.notice()),
            )
            .children(
                self.book
                    .as_ref()
                    .filter(|b| {
                        b.project_registrations
                            .values()
                            .any(|a| a.created.is_none())
                    })
                    .map(|_| {
                        ui::text(
                            Text::Caption,
                            "Folders that may already have been added won't be sent again.",
                        )
                    }),
            )
            .child(ui::rule(window, cx))
            .child(
                div()
                    .h_flex()
                    .justify_end()
                    .items_center()
                    .gap_2()
                    .child(
                        ui::action(
                            "add-project-close",
                            if self.path.is_some() || self.pending {
                                "Close"
                            } else {
                                "Cancel"
                            },
                            Action::Secondary,
                        )
                        .on_click(cx.listener(|v, _, _, cx| v.close(cx))),
                    )
                    .children(refresh.then(|| {
                        ui::action("refresh-projects", "Refresh projects", Action::Quiet)
                            .disabled(!enabled)
                            .on_click(cx.listener(|v, _, _, cx| v.refresh(cx)))
                    }))
                    .child(
                        ui::action("confirm-add-project", "Add project ⌘↩", Action::Primary)
                            .disabled(!confirm)
                            .on_click(cx.listener(|v, _, _, cx| v.confirm(cx))),
                    ),
            )
            .focus_trap("add-project-trap", &self.focus)
    }
}

#[cfg(test)]
#[path = "project_add_view_tests.rs"]
mod tests;
