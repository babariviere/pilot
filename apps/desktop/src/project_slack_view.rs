//! The Slack section of a project page: followed channels and their mention filters, group
//! handles and labels. Edits join the page's draft and are saved by its one Save.
use super::*;
use crate::{
    project_settings::SlackLoad,
    project_slack::{ChannelOption, Effect, Lookup, Source},
    project_slack_reader,
};
use gpui_kit::AnyElement;
use gpui_kit::component::{
    input::InputEvent,
    menu::{DropdownMenu, PopupMenuItem},
};
use std::time::Duration;

/// Results shown under the channel search; more means refine the query.
const SHOWN: usize = 6;

/// A label's two fields, keyed by the label's local identity.
type LabelFields = (Entity<InputState>, Entity<InputState>);

struct LabelInputs {
    fields: LabelFields,
    _changes: [Subscription; 2],
}

#[derive(Default)]
pub(super) struct Ui {
    source: Option<Source>,
    read: Option<(u64, Task<()>)>,
    search: Option<Entity<InputState>>,
    query: String,
    lookup: Option<(String, Lookup)>,
    lookup_task: Option<Task<()>>,
    groups: Option<Entity<InputState>>,
    labels: HashMap<u64, LabelInputs>,
    /// The editor's replaced count the fields last loaded.
    loaded: u64,
    subscriptions: Vec<Subscription>,
}

/// The input entities a render uses, cloned out of the page.
pub(super) struct Fields {
    search: Entity<InputState>,
    groups: Entity<InputState>,
    labels: HashMap<u64, LabelFields>,
}

/// What a native probe drives: the real fields, in draft order.
#[cfg(feature = "native-probes")]
pub(crate) struct Probe {
    pub(crate) search: Option<Entity<InputState>>,
    pub(crate) groups: Option<Entity<InputState>>,
    pub(crate) labels: Vec<LabelFields>,
    /// The lookup for the current query has answered.
    pub(crate) found: bool,
    pub(crate) source: bool,
}

/// A Slack channel ID, as Copy link and the channel details show it.
fn channel_id(query: &str) -> Option<&str> {
    let id = query.trim().trim_start_matches('#');
    (id.len() >= 9
        && id.len() <= 20
        && id.starts_with(['C', 'G'])
        && id
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()))
    .then_some(id)
}

impl ProjectSettings {
    #[cfg(feature = "native-probes")]
    pub(crate) fn slack_probe(&self, id: &str) -> Option<Probe> {
        let page = self.pages.get(id)?;
        Some(Probe {
            search: page.slack.search.clone(),
            groups: page.slack.groups.clone(),
            labels: page
                .editor
                .slack()
                .labels
                .iter()
                .filter_map(|l| page.slack.labels.get(&l.key).map(|i| i.fields.clone()))
                .collect(),
            found: page
                .slack
                .lookup
                .as_ref()
                .is_some_and(|(q, _)| *q == page.slack.query),
            source: page.slack.source.is_some(),
        })
    }
    #[cfg(feature = "native-probes")]
    pub(crate) fn edit_for_probe(
        &mut self,
        id: &str,
        f: impl FnOnce(&mut Editor) -> bool,
        cx: &mut Context<Self>,
    ) {
        self.edit_page(id, f, cx);
    }

    /// Reads one page's tracking value and Slack status. A newer read or a save supersedes it.
    pub(super) fn read_slack(&mut self, id: &str, cx: &mut Context<Self>) {
        let options = self.options.clone();
        let Some(page) = self.pages.get_mut(id) else {
            return;
        };
        let Some(token) = page.editor.begin_read() else {
            return;
        };
        let Some(options) = options else {
            page.editor.finish_read(
                token,
                Err("Preview only. Slack settings aren't loaded here."),
            );
            return;
        };
        let project = id.to_owned();
        let Some(rx) = project_slack_reader::spawn(Duration::from_secs(10), {
            let project = project.clone();
            move |client| async move { project_slack_reader::read(&client, &options, &project).await }
        }) else {
            page.editor
                .finish_read(token, Err("Couldn't load the Slack settings."));
            return;
        };
        let task = cx.spawn(async move |owner, cx| {
            let Ok(read) = rx.recv().await else { return };
            let _ = owner.update(cx, |owner, cx| {
                let Some(page) = owner.pages.get_mut(&project) else {
                    return;
                };
                if page.slack.read.as_ref().is_none_or(|(t, _)| *t != token) {
                    return;
                }
                page.slack.read = None;
                let mut changed = page.editor.finish_read(token, read.tracking);
                if read.source.is_some() && page.slack.source != read.source {
                    page.slack.source = read.source;
                    changed = true;
                }
                if changed {
                    cx.notify();
                }
            });
        });
        page.slack.read = Some((token, task));
    }

    fn edit_page(&mut self, id: &str, f: impl FnOnce(&mut Editor) -> bool, cx: &mut Context<Self>) {
        if let Some(page) = self.pages.get_mut(id)
            && f(&mut page.editor)
        {
            cx.notify();
        }
    }

    pub(super) fn slack_marked(&self, window: &mut Window, cx: &mut App) -> bool {
        self.pages.values().any(|p| {
            let ui = &p.slack;
            ui.search
                .iter()
                .chain(ui.groups.iter())
                .chain(ui.labels.values().flat_map(|l| [&l.fields.0, &l.fields.1]))
                .any(|i| i.update(cx, |i, cx| i.marked_text_range(window, cx).is_some()))
        })
    }

    fn search(&mut self, id: &str, query: String, cx: &mut Context<Self>) {
        let options = self.options.clone();
        let Some(page) = self.pages.get_mut(id) else {
            return;
        };
        if page.slack.query == query {
            return;
        }
        page.slack.query = query.clone();
        page.slack.lookup_task = None;
        if query.trim().is_empty() {
            page.slack.lookup = None;
            cx.notify();
            return;
        }
        let Some(options) = options else {
            page.slack.lookup = Some((query, Lookup::Failed("Preview only.".into())));
            cx.notify();
            return;
        };
        let project = id.to_owned();
        page.slack.lookup_task = Some(cx.spawn(async move |owner, cx| {
            // Typing settles before Slack is asked; the newest query wins.
            cx.background_executor()
                .timer(Duration::from_millis(350))
                .await;
            let text = query.clone();
            let lookup = match project_slack_reader::spawn(
                Duration::from_secs(30),
                move |client| async move {
                    project_slack_reader::channels(&client, &options, &text).await
                },
            ) {
                Some(rx) => rx
                    .recv()
                    .await
                    .unwrap_or_else(|_| Lookup::Failed("Couldn't search Slack channels.".into())),
                None => Lookup::Failed("Couldn't search Slack channels.".into()),
            };
            let _ = owner.update(cx, |owner, cx| {
                if let Some(page) = owner.pages.get_mut(&project)
                    && page.slack.query == query
                {
                    page.slack.lookup = Some((query, lookup));
                    page.slack.lookup_task = None;
                    cx.notify();
                }
            });
        }));
        cx.notify();
    }

    /// Channels to offer for the current query, leaving out those already followed.
    fn candidates(page: &Page) -> (Vec<ChannelOption>, bool) {
        let Some((query, Lookup::Found { items, more })) = &page.slack.lookup else {
            return (Vec::new(), false);
        };
        if *query != page.slack.query {
            return (Vec::new(), false);
        }
        let added = &page.editor.slack().channels;
        let fresh: Vec<_> = items
            .iter()
            .filter(|o| !added.iter().any(|c| c.id == o.id))
            .cloned()
            .collect();
        let more = *more || fresh.len() > SHOWN;
        (fresh.into_iter().take(SHOWN).collect(), more)
    }

    fn add_channel(
        &mut self,
        id: &str,
        channel: &str,
        name: Option<&str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(page) = self.pages.get_mut(id) else {
            return;
        };
        if page.editor.add_channel(channel, name) {
            if let Some(search) = page.slack.search.clone() {
                search.update(cx, |i, cx| i.set_value("", window, cx));
            }
            self.search(id, String::new(), cx);
            cx.notify();
        }
    }

    fn add_first(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(page) = self.pages.get(id) else {
            return;
        };
        let pick = match Self::candidates(page).0.into_iter().next() {
            Some(o) => Some((o.id, Some(o.name))),
            None => channel_id(&page.slack.query).map(|c| (c.to_owned(), None)),
        };
        if let Some((channel, name)) = pick {
            self.add_channel(id, &channel, name.as_deref(), window, cx);
        }
    }

    /// The selected page's Slack fields, created in the window that shows them. They reload
    /// only when the draft is replaced (Revert, a read, a save), never while composing.
    pub(super) fn slack_fields(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Fields> {
        let id = self.selected.clone()?;
        let marked = {
            let page = self.pages.get(&id)?;
            let ui = &page.slack;
            ui.groups
                .iter()
                .chain(ui.labels.values().flat_map(|l| [&l.fields.0, &l.fields.1]))
                .any(|i| i.update(cx, |i, cx| i.marked_text_range(window, cx).is_some()))
        };
        let page = self.pages.get_mut(&id)?;
        if page.slack.search.is_none() {
            let input = cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder("Add a channel: search by name or paste its ID")
            });
            let project = id.clone();
            page.slack.subscriptions.push(cx.subscribe_in(
                &input,
                window,
                move |owner, input, event, window, cx| match event {
                    InputEvent::Change => {
                        let query = input.read(cx).value().to_string();
                        owner.search(&project, query, cx);
                    }
                    InputEvent::PressEnter { .. } => owner.add_first(&project, window, cx),
                    _ => {}
                },
            ));
            page.slack.search = Some(input);
        }
        if page.slack.groups.is_none() {
            let input = cx.new(|cx| InputState::new(window, cx).placeholder("@support, @oncall"));
            let project = id.clone();
            page.slack
                .subscriptions
                .push(cx.observe(&input, move |owner, input, cx| {
                    let value = input.read(cx).value().to_string();
                    owner.edit_page(&project, |e| e.set_groups(&value), cx);
                }));
            page.slack.groups = Some(input);
            page.slack.loaded = page.editor.replaced().wrapping_sub(1);
        }
        let reload = page.slack.loaded != page.editor.replaced() && !marked;
        if reload {
            page.slack.loaded = page.editor.replaced();
            let groups = page.editor.slack().groups.clone();
            if let Some(input) = &page.slack.groups {
                input.update(cx, |i, cx| i.set_value(groups, window, cx));
            }
            page.slack.labels.clear();
        }
        let labels = page.editor.slack().labels.clone();
        page.slack
            .labels
            .retain(|key, _| labels.iter().any(|l| l.key == *key));
        for label in labels {
            if page.slack.labels.contains_key(&label.key) {
                continue;
            }
            let field = |value: String,
                         placeholder: &'static str,
                         window: &mut Window,
                         cx: &mut Context<Self>| {
                cx.new(|cx| {
                    let mut i = InputState::new(window, cx).placeholder(placeholder);
                    i.set_value(value, window, cx);
                    i
                })
            };
            let name = field(label.name.clone(), "Label name", window, cx);
            let description = field(
                label.description.clone(),
                "Which messages get this label, in one sentence",
                window,
                cx,
            );
            let (project, key) = (id.clone(), label.key);
            let named = cx.observe(&name, move |owner, input, cx| {
                let value = input.read(cx).value().to_string();
                owner.edit_page(&project, |e| e.set_label_name(key, &value), cx);
            });
            let project = id.clone();
            let described = cx.observe(&description, move |owner, input, cx| {
                let value = input.read(cx).value().to_string();
                owner.edit_page(&project, |e| e.set_label_description(key, &value), cx);
            });
            page.slack.labels.insert(
                label.key,
                LabelInputs {
                    fields: (name, description),
                    _changes: [named, described],
                },
            );
        }
        Some(Fields {
            search: page.slack.search.clone()?,
            groups: page.slack.groups.clone()?,
            labels: page
                .slack
                .labels
                .iter()
                .map(|(k, i)| (*k, i.fields.clone()))
                .collect(),
        })
    }

    pub(super) fn slack_section(
        &self,
        id: &str,
        fields: Option<Fields>,
        layout: FieldLayout,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let muted = cx.theme().muted_foreground;
        let mut view = div()
            .id("project-slack")
            .test_support()
            .v_flex()
            .gap_4()
            .child(section("project-settings-slack", "Slack"))
            .child(
                ui::text(
                    Text::Caption,
                    "Sorts new messages from these channels for triage, through your pi Slack server. Never posts or starts work.",
                )
                .text_color(muted),
            );
        let Some(page) = self.pages.get(id) else {
            return view.into_any_element();
        };
        let editor = &page.editor;
        if let Some(notice) = page.slack.source.as_ref().and_then(account) {
            view = view.child(notice);
        }
        let this = cx.entity();
        match editor.slack_load() {
            SlackLoad::Loading => {
                return view
                    .child(
                        ui::text(Text::Caption, "Loading Slack settings…")
                            .id("project-slack-loading")
                            .test_support()
                            .text_color(muted),
                    )
                    .into_any_element();
            }
            SlackLoad::Failed(reason) => {
                let (this, id) = (this.clone(), id.to_owned());
                return view
                    .child(
                        div()
                            .id("project-slack-failed")
                            .test_support()
                            .v_flex()
                            .gap_2()
                            .items_start()
                            .child(Notice::new(*reason).tone(Tone::Error))
                            .child(
                                ui::action("project-slack-retry", "Try again", Action::Secondary)
                                    .on_click(move |_, _, cx| {
                                        this.update(cx, |o, cx| o.read_slack(&id, cx))
                                    }),
                            ),
                    )
                    .into_any_element();
            }
            SlackLoad::Unsupported => {
                return view
                    .child(
                        div().id("project-slack-unsupported").test_support().child(
                            Notice::new(
                                "These Slack settings use a format Pilot Next can't edit yet.",
                            )
                            .detail("They stay as they are. Change them in the Pilot app.")
                            .tone(Tone::Warning),
                        ),
                    )
                    .into_any_element();
            }
            SlackLoad::Ready => {}
        }
        let Some(fields) = fields else {
            return view.into_any_element();
        };
        let disabled = !editor.slack_editable();
        let slack = editor.slack();
        if editor.slack_elsewhere() {
            view = view.child(
                div().id("project-slack-elsewhere").test_support().child(
                    Notice::new("Slack settings changed elsewhere.")
                        .detail("Revert to load them. Saving these edits would be refused.")
                        .tone(Tone::Warning),
                ),
            );
        }

        // Channels: each followed channel with its read status and mention filter.
        let mut channels = div()
            .v_flex()
            .gap_3()
            .child(ui::text(Text::Label, "Channels"));
        if slack.channels.is_empty() {
            channels =
                channels.child(ui::text(Text::Caption, "No channels yet.").text_color(muted));
        }
        for (ix, channel) in slack.channels.iter().enumerate() {
            let status = channel_status(editor, page.slack.source.as_ref(), &channel.id);
            let display: SharedString = channel.display().into();
            let (remove, mention) = (
                (this.clone(), id.to_owned(), channel.id.clone()),
                (this.clone(), id.to_owned(), channel.id.clone()),
            );
            channels = channels.child(
                div()
                    .id(SharedString::from(format!("project-slack-channel-{ix}")))
                    .test_support()
                    .v_flex()
                    .gap_1()
                    .child(
                        div()
                            .h_flex()
                            .items_center()
                            .gap_2()
                            .child(
                                ui::text(Text::Body, display.clone())
                                    .id(SharedString::from(format!("project-slack-channel-name-{ix}")))
                                    .test_support()
                                    .min_w_0()
                                    .truncate(),
                            )
                            .child(div().flex_1())
                            .when_some(status, |d, (text, tone)| {
                                d.child(
                                    ui::text(Text::Caption, text)
                                        .id(SharedString::from(format!("project-slack-channel-status-{ix}")))
                                        .test_support()
                                        .truncate()
                                        .text_color(tone.color(cx)),
                                )
                            })
                            .child(
                                ui::icon_action(
                                    SharedString::from(format!("project-slack-remove-{ix}")),
                                    SharedString::from(format!("Stop following {display}")),
                                    crate::ui::IconRole::Close,
                                    Action::Quiet,
                                )
                                .disabled(disabled)
                                .on_click(move |_, _, cx| {
                                    let (this, id, channel) = &remove;
                                    this.update(cx, |o, cx| o.edit_page(id, |e| e.remove_channel(channel), cx))
                                }),
                            ),
                    )
                    .child(
                        Checkbox::new(SharedString::from(format!("project-slack-mention-{ix}")))
                            .label("Only messages that mention me")
                            .checked(channel.mention_only)
                            .disabled(disabled)
                            .on_click(move |on, _, cx| {
                                let (this, id, channel) = &mention;
                                let on = *on;
                                this.update(cx, |o, cx| {
                                    o.edit_page(id, |e| e.set_mention_only(channel, on), cx)
                                })
                            })
                            .child(
                                ui::text(
                                    Text::Caption,
                                    "Keeps new messages that mention you or your groups. Mentions in replies aren't found.",
                                )
                                .text_color(muted),
                            ),
                    ),
            );
        }
        channels = channels.child(
            Input::new(&fields.search)
                .aria_label("Add a Slack channel")
                .disabled(disabled || slack.channels.len() >= crate::project_slack::CHANNELS),
        );
        if !page.slack.query.trim().is_empty() && !disabled {
            channels = channels.child(self.suggestions(id, page, cx));
        }
        view = view.child(channels);

        if slack.shows_groups() {
            view = view.child(
                FieldRow::new(
                    "project-slack-groups",
                    "My Slack groups",
                    Input::new(&fields.groups)
                        .aria_label("My Slack group handles")
                        .disabled(disabled),
                )
                .description("Used by mention-only channels. Slack can't list your groups, so add them here.")
                .layout(layout)
                .when_some(slack.groups_problem(), |r, p| r.validation(p, Tone::Error)),
            );
        }

        // Labels: what the classifier may call a message, and what that does.
        let mut labels = div()
            .v_flex()
            .gap_3()
            .child(ui::text(Text::Label, "Labels"))
            .child(
                ui::text(
                    Text::Caption,
                    "Each message gets at most one label, based on its description and your triage corrections.",
                )
                .text_color(muted),
            );
        for (ix, label) in slack.labels.iter().enumerate() {
            let Some((name, description)) = fields.labels.get(&label.key) else {
                continue;
            };
            let key = label.key;
            let effects = (this.clone(), id.to_owned());
            let remove = (this.clone(), id.to_owned());
            let current = label.effect;
            let title = if label.name.trim().is_empty() {
                "Remove label".to_owned()
            } else {
                format!("Remove {}", label.name.trim())
            };
            labels = labels.child(
                div()
                    .id(SharedString::from(format!("project-slack-label-{ix}")))
                    .test_support()
                    .v_flex()
                    .gap_1()
                    .child(
                        div()
                            .h_flex()
                            .items_center()
                            .gap_2()
                            .child(div().min_w_0().flex_1().child(
                                Input::new(name).aria_label("Label name").disabled(disabled),
                            ))
                            .child(
                                ui::action(
                                    SharedString::from(format!("project-slack-effect-{ix}")),
                                    current.title(),
                                    Action::Secondary,
                                )
                                .disabled(disabled)
                                .tooltip("What this label does to its messages")
                                .dropdown_menu(
                                    move |mut menu, _, _| {
                                        for effect in Effect::ALL {
                                            let (this, id) = effects.clone();
                                            menu = menu.item(
                                                PopupMenuItem::new(effect.title())
                                                    .checked(effect == current)
                                                    .on_click(move |_, _, cx| {
                                                        this.update(cx, |o, cx| {
                                                            o.edit_page(
                                                                &id,
                                                                |e| e.set_label_effect(key, effect),
                                                                cx,
                                                            )
                                                        })
                                                    }),
                                            );
                                        }
                                        menu
                                    },
                                ),
                            )
                            .child(
                                ui::icon_action(
                                    SharedString::from(format!("project-slack-label-remove-{ix}")),
                                    title,
                                    crate::ui::IconRole::Close,
                                    Action::Quiet,
                                )
                                .disabled(disabled)
                                .on_click(move |_, _, cx| {
                                    let (this, id) = &remove;
                                    this.update(cx, |o, cx| {
                                        o.edit_page(id, |e| e.remove_label(key), cx)
                                    })
                                }),
                            ),
                    )
                    .child(
                        Input::new(description)
                            .aria_label("Label description")
                            .disabled(disabled),
                    )
                    .when_some(slack.label_problem(key), |d, p| {
                        d.child(ui::text(Text::Caption, p).text_color(Tone::Error.color(cx)))
                    })
                    .when_some(current.consequence(), |d, text| {
                        let tone = if current == Effect::Close {
                            Tone::Warning
                        } else {
                            Tone::Quiet
                        };
                        d.child(
                            ui::text(Text::Caption, text)
                                .id(SharedString::from(format!(
                                    "project-slack-effect-note-{ix}"
                                )))
                                .test_support()
                                .text_color(tone.color(cx)),
                        )
                    }),
            );
        }
        let add = (this.clone(), id.to_owned());
        labels = labels.child(
            div().child(
                ui::action("project-slack-add-label", "Add label", Action::Quiet)
                    .disabled(disabled || slack.labels.len() >= crate::project_slack::LABELS)
                    .on_click(move |_, _, cx| {
                        let (this, id) = &add;
                        this.update(cx, |o, cx| o.edit_page(id, |e| e.add_label().is_some(), cx))
                    }),
            ),
        );
        view.child(labels).into_any_element()
    }

    fn suggestions(&self, id: &str, page: &Page, cx: &mut Context<Self>) -> AnyElement {
        let (options, more) = Self::candidates(page);
        let this = cx.entity();
        let mut list = div()
            .id("project-slack-suggestions")
            .test_support()
            .v_flex()
            .gap_1()
            .items_start();
        for (ix, option) in options.iter().enumerate() {
            let pick = (
                this.clone(),
                id.to_owned(),
                option.id.clone(),
                option.name.clone(),
            );
            let label = if option.private {
                format!("#{} · Private", option.name)
            } else {
                format!("#{}", option.name)
            };
            list = list.child(
                ui::action(
                    SharedString::from(format!("project-slack-option-{ix}")),
                    label,
                    Action::Quiet,
                )
                .tooltip("Follow this channel")
                .on_click(move |_, window, cx| {
                    let (this, id, channel, name) = &pick;
                    this.update(cx, |o, cx| {
                        o.add_channel(id, channel, Some(name), window, cx)
                    })
                }),
            );
        }
        let typed = channel_id(&page.slack.query)
            .filter(|c| !page.editor.slack().channels.iter().any(|x| x.id == *c))
            .filter(|c| !options.iter().any(|o| o.id == *c));
        if let Some(channel) = typed {
            let pick = (this.clone(), id.to_owned(), channel.to_owned());
            list = list.child(
                ui::action(
                    "project-slack-add-id",
                    SharedString::from(format!("Add channel {channel}")),
                    Action::Quiet,
                )
                .on_click(move |_, window, cx| {
                    let (this, id, channel) = &pick;
                    this.update(cx, |o, cx| o.add_channel(id, channel, None, window, cx))
                }),
            );
        }
        let current = page
            .slack
            .lookup
            .as_ref()
            .filter(|(q, _)| *q == page.slack.query)
            .map(|(_, l)| l);
        let note: Option<(SharedString, Tone)> = match current {
            None => Some(("Searching…".into(), Tone::Quiet)),
            Some(Lookup::SignIn) => Some((
                "Sign in to Slack to search. You can still paste a channel ID.".into(),
                Tone::Warning,
            )),
            Some(Lookup::Failed(reason)) => Some((reason.clone().into(), Tone::Error)),
            Some(Lookup::Found { .. }) if options.is_empty() && typed.is_none() => {
                Some(("No channels match.".into(), Tone::Quiet))
            }
            Some(Lookup::Found { .. }) if more => {
                Some(("Refine the search to see more.".into(), Tone::Quiet))
            }
            Some(Lookup::Found { .. }) => None,
        };
        list.when_some(note, |d, (text, tone)| {
            d.child(
                ui::text(Text::Caption, text)
                    .id("project-slack-search-note")
                    .test_support()
                    .text_color(tone.color(cx)),
            )
        })
        .into_any_element()
    }
}

/// What the page should say about the Slack account, only when it needs attention.
fn account(source: &Source) -> Option<AnyElement> {
    let notice = match source.status.as_str() {
        "sign_in_required" => Notice::new("Slack needs sign-in.")
            .detail(match &source.sign_in_command {
                Some(command) => {
                    format!("Sign in from the Pilot app, or run {command} in a terminal.")
                }
                None => "Sign in from the Pilot app.".into(),
            })
            .tone(Tone::Warning),
        "error" => Notice::new("Pilot couldn't read Slack.")
            .detail(
                source
                    .error
                    .clone()
                    .unwrap_or_else(|| "It will try again on its own.".into()),
            )
            .tone(Tone::Warning),
        _ if source.budget_limited => Notice::new("Slack reading is paused until the next hour.")
            .detail("Pilot reached its hourly Slack budget. It resumes on its own.")
            .tone(Tone::Quiet),
        _ => return None,
    };
    Some(
        div()
            .id("project-slack-account")
            .test_support()
            .child(notice)
            .into_any_element(),
    )
}

/// A followed channel's read status, only when there is something to say.
fn channel_status(
    editor: &Editor,
    source: Option<&Source>,
    id: &str,
) -> Option<(SharedString, Tone)> {
    if !editor.slack_saved(id) {
        return Some(("Read after you save".into(), Tone::Quiet));
    }
    let health = source?.channel(id)?;
    match health.status.as_str() {
        "pending" => Some(("Not read yet".into(), Tone::Quiet)),
        "sign_in_required" => Some(("Needs Slack sign-in".into(), Tone::Warning)),
        "error" => Some((
            health
                .error
                .clone()
                .unwrap_or_else(|| "Couldn't read this channel".into())
                .into(),
            Tone::Warning,
        )),
        _ => None,
    }
}
