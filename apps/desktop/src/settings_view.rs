//! Real Settings feature, composed from the app's shared `ui` contract.
//! The owner retains edits across window close; one bounded worker owns private I/O.
use crate::{
    settings_state::{
        AppearancePreference, LoadedPreferences, Preferences, SettingsError, SettingsState,
    },
    settings_worker::{Command, SettingsWorker, Update},
    ui::{self, Action, FieldLayout, FieldRow, Notice, ResourceLabel, Surface, Text, Tone},
};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::{
    App, AppContext, Context, Entity, EventEmitter, FocusHandle, Focusable, InteractiveElement,
    IntoElement, ParentElement, Render, SharedString, Styled, Subscription, Task, TestSupportExt,
    Window, actions,
    component::{
        ActiveTheme, Disableable, IndexPath, Selectable, Sizable, StyledExt,
        button::ButtonGroup,
        list::{List, ListDelegate, ListEvent, ListItem, ListState},
        scroll::ScrollableElement,
    },
    div,
};
use std::path::PathBuf;

actions!(settings, [OpenSettings, CloseSettings, SaveSettings]);

/// Non-rendering state owner retained by the Local window and any open Settings window.
pub(crate) struct SettingsPreferences {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) updater: Option<Entity<crate::updates_view::Updates>>,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) update_location: Option<pilot_desktop_updater::coordination::Location>,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    update_events: Vec<Subscription>,
    pub(crate) restart_locked: bool,
    pub(crate) models: Option<Entity<crate::scoped_models_view::ScopedModels>>,
    pub(super) state: SettingsState,
    source: Option<Result<PathBuf, SettingsError>>,
    worker: Option<SettingsWorker>,
    updates: Option<Task<()>>,
    generation: u64,
    pub(super) category: Category,
    close_notice: bool,
}
impl SettingsPreferences {
    pub(crate) fn new(source: Option<Result<PathBuf, SettingsError>>) -> Self {
        Self {
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            updater: None,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            update_location: None,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            update_events: Vec::new(),
            restart_locked: false,
            models: None,
            state: SettingsState::default(),
            source,
            worker: None,
            updates: None,
            generation: 1,
            category: Category::Appearance,
            close_notice: false,
        }
    }
    pub(crate) fn writable(&self) -> bool {
        self.source.is_some() && self.state.loaded() && !self.restart_locked
    }
    pub(crate) fn load(&mut self, cx: &mut Context<Self>) {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if self.updater.is_none() {
            let location = self.update_location.clone();
            let updater = cx.new(|cx| crate::updates_view::Updates::new(location, cx));
            self.update_events
                .push(cx.subscribe(&updater, |_, _, event, cx| cx.emit(*event)));
            self.updater = Some(updater);
        }
        crate::typography::prepare(cx);
        if !self.state.begin_load() {
            return;
        }
        match self.source.clone() {
            None => {
                self.state.finish_load(Ok(LoadedPreferences {
                    preferences: Preferences::default(),
                    persisted: false,
                }));
            }
            Some(Err(error)) => {
                self.state.finish_load(Err(error));
            }
            Some(Ok(root)) => {
                if self.worker.is_none() {
                    match SettingsWorker::start(root) {
                        Err(error) => {
                            self.state.finish_load(Err(error));
                            cx.notify();
                            return;
                        }
                        Ok((worker, updates)) => {
                            self.worker = Some(worker);
                            self.updates = Some(cx.spawn(async move |owner, cx| {
                                while let Ok(update) = updates.recv().await {
                                    if owner
                                        .update(cx, |owner, cx| owner.accept(update, cx))
                                        .is_err()
                                    {
                                        break;
                                    }
                                }
                            }));
                        }
                    }
                }
                if let Err(error) = self
                    .worker
                    .as_ref()
                    .unwrap()
                    .command(Command::Load(self.generation))
                {
                    self.state.finish_load(Err(error));
                }
            }
        }
        cx.notify();
    }
    fn accept(&mut self, update: Update, cx: &mut Context<Self>) {
        let committed = match update {
            Update::Loaded(generation, result) if generation == self.generation => {
                let preferences = result.as_ref().ok().map(|loaded| loaded.preferences);
                self.state
                    .finish_load(result)
                    .then_some(preferences)
                    .flatten()
            }
            Update::Saved(generation, request, result) if generation == self.generation => {
                let success = result.is_ok();
                (self.state.finish_save(request, result) && success)
                    .then_some(request.preferences())
            }
            _ => return,
        };
        if let Some(preferences) = committed {
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            if let Some(updater) = &self.updater {
                updater.update(cx, |updater, cx| {
                    updater.automatic(preferences.automatic_update_checks, cx)
                });
            }
            self.close_notice = false;
            crate::appearance::commit_appearance(preferences.appearance, cx);
            crate::typography::commit(preferences.fonts, cx);
        }
        cx.notify();
    }
    pub(super) fn select(&mut self, appearance: AppearancePreference, cx: &mut Context<Self>) {
        if self.writable() && self.state.set_appearance(appearance) {
            cx.notify();
        }
    }
    pub(super) fn save(&mut self, cx: &mut Context<Self>) {
        if !self.writable() {
            return;
        }
        let Some(request) = self.state.begin_save() else {
            return;
        };
        self.dispatch_save(request, cx);
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) fn persist_update_checkpoint(&mut self, cx: &mut Context<Self>) {
        if !self.writable() {
            return;
        }
        if let Some(request) = self.state.begin_durability_checkpoint() {
            self.dispatch_save(request, cx);
        }
    }
    fn dispatch_save(
        &mut self,
        request: crate::settings_state::SaveRequest,
        cx: &mut Context<Self>,
    ) {
        let result = self
            .worker
            .as_ref()
            .ok_or(SettingsError::Io)
            .and_then(|worker| worker.command(Command::Save(self.generation, Box::new(request))));
        if let Err(error) = result {
            self.state.finish_save(request, Err(error));
        }
        cx.notify();
    }
    pub(super) fn fonts(
        &mut self,
        fonts: crate::settings_state::FontPreferences,
        cx: &mut Context<Self>,
    ) {
        if self.writable() && !self.state.unconfirmed() && self.state.set_fonts(fonts) {
            cx.notify();
        }
    }
    fn revert(&mut self, cx: &mut Context<Self>) {
        if self.state.revert() {
            self.close_notice = false;
            cx.notify();
        }
    }
    /// Explicit recovery only. First click exposes the consequence; second confirms it.
    fn reload(&mut self, cx: &mut Context<Self>) {
        if self.state.saving() || self.state.loading() || self.state.unconfirmed() {
            return;
        }
        self.generation = self
            .generation
            .checked_add(1)
            .expect("settings generation exhausted");
        self.state = SettingsState::default();
        self.load(cx);
    }
    pub(crate) fn request_close(&mut self, cx: &mut Context<Self>) -> bool {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if self
            .updater
            .as_ref()
            .is_some_and(|u| u.read(cx).unsaved_access(cx))
        {
            self.close_notice = true;
            cx.notify();
            return false;
        }
        let ready = !self.restart_locked
            && !self.state.saving()
            && !self.state.dirty()
            && !self.state.unconfirmed()
            && self
                .models
                .as_ref()
                .is_none_or(|m| !m.read(cx).unsettled(cx));
        if !ready {
            self.close_notice = true;
            cx.notify();
        }
        ready
    }
}
#[cfg(any(target_os = "macos", target_os = "linux"))]
impl EventEmitter<crate::updates_view::Event> for SettingsPreferences {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Category {
    Appearance,
    Models,
    Updates,
}
impl Category {
    const ALL: [Self; 3] = [Self::Appearance, Self::Models, Self::Updates];
    fn title(self) -> &'static str {
        match self {
            Self::Appearance => "Appearance",
            Self::Models => "Scoped models",
            Self::Updates => "Updates",
        }
    }
    fn id(self) -> &'static str {
        match self {
            Self::Appearance => "settings-appearance",
            Self::Models => "settings-models",
            Self::Updates => "settings-updates",
        }
    }
}
struct Categories {
    current: Category,
    selected: Option<IndexPath>,
}
impl ListDelegate for Categories {
    type Item = ListItem;
    fn items_count(&self, _: usize, _: &App) -> usize {
        Category::ALL.len()
    }
    fn render_item(
        &mut self,
        ix: IndexPath,
        _: &mut Window,
        _: &mut Context<ListState<Self>>,
    ) -> Option<ListItem> {
        let category = Category::ALL.get(ix.row)?;
        Some(
            ListItem::new(category.id())
                .confirmed(*category == self.current)
                .child(ResourceLabel::new(category.title())),
        )
    }
    fn set_selected_index(
        &mut self,
        ix: Option<IndexPath>,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) {
        self.selected = ix;
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
        _: &mut Context<ListState<Self>>,
    ) -> impl IntoElement {
        div()
    }
}

pub(crate) enum SettingsEvent {
    Quit,
}
/// One native Settings window. No project selection or canonical project mutations.
pub(crate) struct SettingsView {
    pub(super) preferences: Entity<SettingsPreferences>,
    categories: Entity<ListState<Categories>>,
    focus: FocusHandle,
    _subscriptions: Vec<Subscription>,
    confirm_reload: bool,
    #[cfg(feature = "native-probes")]
    pub(super) render_count: u64,
    #[cfg(feature = "native-probes")]
    pub(super) long_labels: bool,
}
impl EventEmitter<SettingsEvent> for SettingsView {}
impl Focusable for SettingsView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}
impl SettingsView {
    pub(crate) fn new(
        preferences: Entity<SettingsPreferences>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        crate::typography::prepare(cx);
        let category = preferences.read(cx).category;
        let categories = cx.new(|cx| {
            ListState::new(
                Categories {
                    current: category,
                    selected: None,
                },
                window,
                cx,
            )
            .searchable(false)
        });
        categories.update(cx, |list, cx| {
            list.set_selected_index(
                Some(IndexPath::new(
                    Category::ALL.iter().position(|c| *c == category).unwrap(),
                )),
                window,
                cx,
            )
        });
        let observed = cx.observe(&preferences, |_, _, cx| cx.notify());
        let selected = cx.subscribe_in(&categories, window, |view, list, event, window, cx| {
            if view.models_marked(window, cx) {
                return;
            }
            if let ListEvent::Confirm(ix) = event
                && let Some(category) = Category::ALL.get(ix.row).copied()
            {
                list.update(cx, |list, cx| {
                    list.delegate_mut().current = category;
                    cx.notify();
                });
                view.preferences.update(cx, |owner, cx| {
                    owner.category = category;
                    cx.notify();
                });
                view.confirm_reload = false;
                if category == Category::Models
                    && let Some(models) = view.preferences.read(cx).models.clone()
                {
                    models.update(cx, |m, cx| m.load(window, cx));
                }
                cx.notify();
            }
        });
        Self {
            preferences,
            categories,
            focus: cx.focus_handle(),
            _subscriptions: vec![observed, selected],
            confirm_reload: false,
            #[cfg(feature = "native-probes")]
            render_count: 0,
            #[cfg(feature = "native-probes")]
            long_labels: false,
        }
    }
    pub(crate) fn focus_categories(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.categories
            .update(cx, |list, cx| list.focus(window, cx));
    }
    pub(crate) fn request_close(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.models_marked(window, cx) {
            return false;
        }
        self.preferences
            .update(cx, |owner, cx| owner.request_close(cx))
    }
    fn models_marked(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if self
            .preferences
            .read(cx)
            .updater
            .clone()
            .is_some_and(|u| u.update(cx, |u, cx| u.marked(w, cx)))
        {
            return true;
        }
        self.preferences
            .read(cx)
            .models
            .clone()
            .is_some_and(|m| m.update(cx, |m, cx| m.marked(w, cx)))
    }
    fn appearance(&self, window: &Window, cx: &mut Context<Self>) -> gpui_kit::Div {
        let owner = self.preferences.read(cx);
        let current = owner.state.current().appearance;
        let writable = owner.writable();
        let disabled = !writable || owner.state.unconfirmed();
        // The page is already titled Appearance; the row names its choice.
        let label = "Theme";
        #[cfg(feature = "native-probes")]
        let label = if self.long_labels {
            "Appearance for conversations, code and every app-owned surface, including a deliberately long translated label 資料 👩‍💻"
        } else {
            label
        };
        let wide = window.viewport_size().width > gpui_kit::px(800.);
        let options = [
            ("settings-system", "System", AppearancePreference::System),
            ("settings-light", "Light", AppearancePreference::Light),
            ("settings-dark", "Dark", AppearancePreference::Dark),
        ];
        let controls = ButtonGroup::new("settings-theme-choice")
            .small()
            .outline()
            .disabled(disabled)
            .children(options.map(|(id, label, appearance)| {
                let preferences = self.preferences.clone();
                ui::action(id, label, Action::Secondary)
                    .selected(current == appearance)
                    .disabled(disabled)
                    .accessibility_label(SharedString::from(format!("Appearance: {label}")))
                    .on_click(move |_, _, cx| {
                        preferences.update(cx, |owner, cx| owner.select(appearance, cx))
                    })
            }));
        let fonts = owner.state.current().fonts;
        div()
            .v_flex()
            .gap(gpui_kit::px(ui::Space::SECTION))
            .child(ui::header("settings-page-title", "Appearance", Text::Title))
            .child(
                FieldRow::new("settings-theme-field", label, controls).layout(if wide {
                    FieldLayout::Inline
                } else {
                    FieldLayout::Stacked
                }),
            )
            .child(
                div()
                    .v_flex()
                    .gap_3()
                    .child(ui::heading(
                        "settings-preview-heading",
                        "Preview",
                        Text::Headline,
                    ))
                    .child(
                        ui::surface(Surface::Tray, cx).p_3().rounded_lg().child(
                            ui::surface(Surface::Card, cx)
                                .p_4()
                                .rounded_lg()
                                .v_flex()
                                .gap_3()
                                .child(
                                    div()
                                        .id("settings-chat-preview")
                                        .test_support()
                                        .font_family(crate::typography::family(
                                            fonts.chat_family,
                                            false,
                                            cx,
                                        ))
                                        .when_some(fonts.chat_size, |d, size| {
                                            d.text_size(gpui_kit::px(size as f32 / 2.))
                                        })
                                        .child("The change is ready to review. Café · 資料 · 👩‍💻"),
                                )
                                .child(
                                    div()
                                        .id("settings-code-preview")
                                        .test_support()
                                        .font_family(crate::typography::family(
                                            fonts.code_family,
                                            true,
                                            cx,
                                        ))
                                        .text_size(gpui_kit::px(
                                            fonts
                                                .code_size
                                                .map(|s| s as f32 / 2.)
                                                .unwrap_or(f32::from(cx.theme().mono_font_size)),
                                        ))
                                        .text_color(cx.theme().muted_foreground)
                                        .child("cargo test --locked"),
                                ),
                        ),
                    ),
            )
            .child(self.font_controls(false, fonts, disabled, wide, cx))
            .child(self.font_controls(true, fonts, disabled, wide, cx))
            .child(
                ui::action(
                    "settings-font-defaults",
                    "Restore font defaults",
                    Action::Quiet,
                )
                .disabled(disabled || fonts == Default::default())
                .on_click({
                    let preferences = self.preferences.clone();
                    move |_, _, cx| {
                        preferences.update(cx, |o, cx| o.fonts(Default::default(), cx));
                    }
                }),
            )
    }
    /// None when there is nothing to say or do: the footer then disappears.
    fn status(&mut self, cx: &mut Context<Self>) -> Option<gpui_kit::Div> {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if self.preferences.read(cx).close_notice
            && self
                .preferences
                .read(cx)
                .updater
                .as_ref()
                .is_some_and(|u| u.read(cx).unsaved_access(cx))
        {
            return Some(div().child(Notice::new("Use or clear the update access field before closing. It is never saved to disk.").tone(Tone::Warning)));
        }
        let owner = self.preferences.read(cx);
        let state = &owner.state;
        let status = if owner.source.is_none() {
            Some("Preview only. Preferences cannot be saved.")
        } else if state.loading() {
            Some("Loading preferences…")
        } else if state.saving() {
            Some("Saving preferences…")
        } else if state.unconfirmed() {
            Some("Save is unconfirmed. Retry before making another save.")
        } else if state.dirty() {
            Some("Unsaved changes")
        } else if state.persisted() || (state.loaded() && state.committed().is_none()) {
            None
        } else {
            Some("Preferences unavailable")
        };
        let error = state.error();
        let dirty = state.dirty();
        let saving = state.saving();
        let loading = state.loading();
        let unconfirmed = state.unconfirmed();
        let writable = owner.writable();
        let source = owner.source.is_some();
        let close_notice = owner.close_notice;
        if owner.category == Category::Models
            && !dirty
            && !saving
            && !unconfirmed
            && error.is_none()
        {
            let models_unsettled = owner
                .models
                .as_ref()
                .is_some_and(|m| m.read(cx).unsettled(cx));
            return (close_notice&&models_unsettled).then(||div().v_flex().gap_2()
                .child(Notice::new("Finish or review your scoped-model changes before closing. No request is resent by closing.").tone(Tone::Warning)));
        }
        // Save/Revert appear only once something changed, is saving or failed.
        let show_actions = dirty || saving || unconfirmed || error.is_some();
        if status.is_none() && !show_actions && !self.confirm_reload {
            return None;
        }
        let mut panel = div().v_flex().gap_3().children(status.map(|status| {
            ui::text(Text::Caption, status)
                .id("settings-status")
                .test_support()
                .text_color(cx.theme().muted_foreground)
        }));
        if let Some(error) = error {
            panel = panel.child(Notice::new(error.message()).tone(Tone::Error));
        }
        if close_notice && (dirty || saving) && error.is_none() {
            panel = panel.child(
                Notice::new("Save or revert your appearance changes before closing.")
                    .tone(Tone::Warning),
            );
        }
        let owner = self.preferences.clone();
        let reload = self.preferences.clone();
        let save = self.preferences.clone();
        let mut actions = div()
            .h_flex()
            .flex_wrap()
            .gap_2()
            .child(
                ui::action("settings-revert", "Revert", Action::Secondary)
                    .disabled(!writable || !dirty || saving || unconfirmed)
                    .on_click(move |_, _, cx| owner.update(cx, |owner, cx| owner.revert(cx))),
            )
            .child(
                ui::action(
                    "settings-save",
                    if error.is_some() {
                        "Retry save"
                    } else {
                        "Save changes"
                    },
                    Action::Primary,
                )
                .loading(saving)
                .disabled(!writable || !dirty || saving)
                .tooltip("Save appearance changes (⌘S)")
                .on_click(move |_, _, cx| save.update(cx, |owner, cx| owner.save(cx))),
            );
        if source && !loading && !saving && error.is_some() {
            actions = actions.child(
                ui::action(
                    "settings-reload",
                    if self.confirm_reload {
                        "Discard edits and reload"
                    } else {
                        "Reload saved…"
                    },
                    Action::Quiet,
                )
                .disabled(unconfirmed)
                .on_click(cx.listener(move |view, _, _, cx| {
                    if view.confirm_reload || !view.preferences.read(cx).state.dirty() {
                        view.confirm_reload = false;
                        reload.update(cx, |owner, cx| owner.reload(cx));
                    } else {
                        view.confirm_reload = true;
                        cx.notify();
                    }
                })),
            );
        }
        if self.confirm_reload {
            panel = panel.child(
                Notice::new("Reload discards your unsaved appearance selection.")
                    .tone(Tone::Warning),
            );
        }
        Some(if show_actions {
            panel.child(actions)
        } else {
            panel
        })
    }
}
impl SettingsView {
    fn updates(&self, cx: &mut Context<Self>) -> impl IntoElement {
        use gpui_kit::component::checkbox::Checkbox;
        let preferences = self.preferences.clone();
        let owner = preferences.read(cx);
        let writable = owner.writable() && !owner.state.unconfirmed();
        let automatic = owner.state.current().automatic_update_checks;
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let updater = owner.updater.clone();
        let mut view = div()
            .v_flex()
            .gap_4()
            .child(ui::header("settings-page-title", "Updates", Text::Title))
            .child(
                Checkbox::new("updates-automatic")
                    .label("Automatically check for updates")
                    .checked(automatic)
                    .disabled(!writable)
                    .on_click(move |checked, _, cx| {
                        preferences.update(cx, |owner, cx| {
                            if owner.writable() && owner.state.set_automatic_update_checks(*checked)
                            {
                                cx.notify();
                            }
                        })
                    }),
            )
            .child(ui::text(
                Text::Caption,
                "Installation requires confirmation.",
            ));
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            if let Some(updater) = updater {
                view = view.child(updater);
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            view=view.child(Notice::new("Updates are available only for verified macOS arm64 and Linux x86-64 bundles. No installer is enabled on this platform."));
        }
        view
    }
}
impl Render for SettingsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        #[cfg(feature = "native-probes")]
        {
            self.render_count += 1;
        }
        let category = if self.preferences.read(cx).restart_locked {
            Category::Updates
        } else {
            self.preferences.read(cx).category
        };
        let detail = match category {
            Category::Appearance => self.appearance(window, cx).into_any_element(),
            Category::Models=>self.preferences.read(cx).models.clone().map(|m|div().child(m).into_any_element()).unwrap_or_else(||Notice::new("Scoped models require the real Local viewer. This synthetic Settings window has no daemon authority.").into_any_element()),
            Category::Updates => self.updates(cx).into_any_element(),
        };
        let status = self.status(cx);
        div()
            .id("settings-root")
            .test_support()
            .track_focus(&self.focus)
            .key_context("Settings")
            .size_full()
            .h_flex()
            .items_stretch()
            .bg(Surface::Page.color(cx))
            .text_color(cx.theme().foreground)
            .capture_any_mouse_down(cx.listener(|v, _, w, cx| {
                if v.models_marked(w, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|v, _: &gpui_kit::base::input::Escape, w, cx| {
                if v.models_marked(w, cx) {
                    cx.stop_propagation();
                }
            }))
            .on_action(cx.listener(|view, _: &CloseSettings, window, cx| {
                if view.request_close(window, cx) {
                    window.remove_window();
                }
            }))
            .on_action(cx.listener(|view, _: &SaveSettings, window, cx| {
                if view.preferences.read(cx).category == Category::Models {
                    if let Some(models) = view.preferences.read(cx).models.clone() {
                        models.update(cx, |m, cx| m.save(window, cx));
                    }
                } else {
                    view.preferences.update(cx, |owner, cx| owner.save(cx));
                }
                cx.stop_propagation();
            }))
            .on_action(cx.listener(|_, _: &crate::transcript_view::Quit, _, cx| {
                cx.emit(SettingsEvent::Quit);
                cx.stop_propagation();
            }))
            .child(
                ui::surface(Surface::Sidebar, cx)
                    .id("settings-sidebar")
                    .test_support()
                    .v_flex()
                    .w_40()
                    .min_w_40()
                    .h_full()
                    .border_r_1()
                    .border_color(cx.theme().border)
                    .pt(gpui_kit::px(crate::ui::Space::SIDEBAR))
                    .child(div().flex_1().min_h_0().child(List::new(&self.categories))),
            )
            .child(
                div()
                    .id("settings-detail")
                    .test_support()
                    .v_flex()
                    .flex_1()
                    .min_w_0()
                    .min_h_0()
                    .h_full()
                    .child(
                        div()
                            .id("settings-scroll")
                            .test_support()
                            .v_flex()
                            .flex_1()
                            .min_h_0()
                            .min_w_0()
                            .child(
                                div()
                                    .size_full()
                                    .overflow_y_scrollbar()
                                    .child(ui::page().child(detail)),
                            ),
                    )
                    .children(status.map(|status| {
                        div()
                            .p_4()
                            .border_t_1()
                            .border_color(cx.theme().border)
                            .child(status)
                    })),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::{
        TestAppContext,
        component::{Theme, ThemeMode},
    };

    #[gpui_kit::test]
    fn replies_are_owner_generation_fenced_and_theme_follows_only_ack(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init_appearance(cx);
            Theme::change(ThemeMode::Light, None, cx);
        });
        let owner =
            cx.update(|cx| cx.new(|_| SettingsPreferences::new(Some(Err(SettingsError::Io)))));
        owner.update(cx, |owner, cx| {
            owner.state.begin_load();
            owner.accept(
                Update::Loaded(
                    0,
                    Ok(LoadedPreferences {
                        preferences: Preferences {
                            appearance: AppearancePreference::Dark,
                            ..Default::default()
                        },
                        persisted: true,
                    }),
                ),
                cx,
            );
            assert!(owner.state.loading());
            assert!(!cx.theme().is_dark());
            owner.accept(
                Update::Loaded(
                    1,
                    Ok(LoadedPreferences {
                        preferences: Preferences::default(),
                        persisted: false,
                    }),
                ),
                cx,
            );
            assert!(owner.state.loaded());
            // Fix the synthetic system observation for this explicit consumer test.
            Theme::change(ThemeMode::Light, None, cx);
            owner.select(AppearancePreference::Dark, cx);
            let request = owner.state.begin_save().unwrap();
            owner.select(AppearancePreference::Light, cx);
            owner.accept(Update::Saved(0, request, Ok(())), cx);
            assert!(owner.state.saving());
            assert!(!cx.theme().is_dark());
            owner.accept(
                Update::Saved(1, request, Err(SettingsError::DurabilityUnknown)),
                cx,
            );
            assert!(owner.state.unconfirmed());
            assert!(!cx.theme().is_dark());
            let generation = owner.generation;
            owner.reload(cx);
            assert_eq!(
                generation, owner.generation,
                "cannot discard an unconfirmed store/model pair"
            );
            let retry = owner.state.begin_save().unwrap();
            assert_eq!(retry.preferences().appearance, AppearancePreference::Dark);
            owner.accept(Update::Saved(1, retry, Ok(())), cx);
            assert!(cx.theme().is_dark());
            assert_eq!(
                owner.state.current().appearance,
                AppearancePreference::Light
            );
            assert!(owner.state.dirty());
            Theme::change(ThemeMode::Light, None, cx);
            owner.accept(Update::Saved(1, request, Ok(())), cx);
            assert!(
                !cx.theme().is_dark(),
                "duplicate old receipt cannot apply a theme"
            );
        });
    }
    #[gpui_kit::test]
    fn construction_and_synthetic_load_do_not_start_io_or_apply_theme(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init_appearance(cx);
            Theme::change(ThemeMode::Dark, None, cx);
        });
        let owner = cx.update(|cx| cx.new(|_| SettingsPreferences::new(None)));
        owner.update(cx, |owner, cx| {
            assert!(owner.worker.is_none());
            assert!(owner.updates.is_none());
            assert!(!owner.state.loaded());
            owner.load(cx);
            assert!(owner.state.loaded());
            assert!(!owner.writable());
            owner.select(AppearancePreference::Light, cx);
            owner.save(cx);
            assert!(!owner.state.dirty());
            assert!(cx.theme().is_dark());
            assert!(owner.worker.is_none());
            assert!(owner.updates.is_none());
        });
    }
}
