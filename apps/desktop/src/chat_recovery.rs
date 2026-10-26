//! Contextual recovery, never a permanent second composer toolbar.
use super::*;
use gpui_kit::component::popover::Popover;
impl ChatEditor {
    pub(super) fn recovery_menu(
        &self,
        key: &str,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let editor = cx.entity().downgrade();
        let key = key.to_string();
        div()
            .self_start()
            .capture_any_mouse_down(cx.listener(|view, _, window, cx| {
                if view.marked(window, cx) {
                    cx.stop_propagation();
                }
            }))
            .child(
                Popover::new(SharedString::from(format!("composer-recovery:{key}")))
                    .trigger(
                        crate::ui::action(
                            "composer-recovery",
                            "Recovery…",
                            crate::ui::Action::Quiet,
                        )
                        .tooltip(
                            "Inspect or manage this draft's unresolved delivery and recovered text",
                        ),
                    )
                    .content(move |_, _, cx| {
                        editor
                            .update(cx, |view, cx| view.recovery_actions(&key, cx))
                            .unwrap_or_else(|_| div().into_any_element())
                    }),
            )
    }
    fn recovery_actions(&self, key: &str, cx: &mut Context<Self>) -> gpui_kit::AnyElement {
        if self.selected.as_deref() != Some(key) {
            return div().into_any_element();
        }
        let Some(draft) = self.cache.get(key) else {
            return div().into_any_element();
        };
        let key = key.to_string();
        let pending = draft
            .pending
            .as_ref()
            .and_then(|id| self.state.book.as_ref().and_then(|b| b.pending.get(id)));
        let discardable =
            key.starts_with("new:") || draft.pending.is_some() || draft.created.is_some();
        let mut actions = div()
            .id("composer-recovery-actions")
            .v_flex()
            .gap_2()
            .p_2()
            .w(px(300.))
            .max_w(px(320.));
        if (pending.is_some()
            || draft
                .last
                .as_ref()
                .is_some_and(|last| last.state == "rejected"))
            && let Some((_, caption)) = self.delivery_detail(&key, draft)
        {
            let detail = div()
                .id("delivery-diagnostic")
                .min_w_0()
                .child(crate::ui::text(crate::ui::Text::Caption, caption));
            #[cfg(any(test, feature = "native-probes"))]
            let detail = detail.test_support();
            actions = actions.child(detail);
        }
        if let Some(intent) = pending {
            let id = intent.id.clone();
            let retry_id = id.clone();
            let dismiss_id = id.clone();
            actions = actions.child(
                div()
                    .v_flex()
                    .gap_2()
                    .when(intent.operation.is_some(), |actions| {
                        actions
                            .child(
                                Button::new("check-delivery")
                                    .small()
                                    .w_full()
                                    .label("Check")
                                    .icon(AppIcon::Retry.asset())
                                    .disabled(intent.operation.is_none())
                                    .on_click(cx.listener(move |view, _, _, _| {
                                        if let Some(client) = &view.client {
                                            client.command(WriteCommand::Check {
                                                id: id.clone(),
                                                retry: false,
                                            });
                                        }
                                    })),
                            )
                            .child(
                                Button::new("retry-delivery")
                                    .small()
                                    .w_full()
                                    .label("Retry same intent")
                                    .icon(AppIcon::Retry.asset())
                                    .disabled(
                                        intent.operation.is_none() || intent.state == "pending",
                                    )
                                    .on_click(cx.listener(move |view, _, _, _| {
                                        if let Some(client) = &view.client {
                                            client.command(WriteCommand::Check {
                                                id: retry_id.clone(),
                                                retry: true,
                                            });
                                        }
                                    })),
                            )
                    })
                    .when(intent.operation.is_none(), |actions| {
                        actions.child(
                            Button::new("dismiss-stop")
                                .small()
                                .w_full()
                                .label("Acknowledge Stop uncertainty")
                                .icon(AppIcon::Info.asset())
                                .disabled(intent.operation.is_some())
                                .on_click(cx.listener(move |view, _, _, _| {
                                    if let Some(client) = &view.client {
                                        client.command(WriteCommand::DismissStop {
                                            id: dismiss_id.clone(),
                                        });
                                    }
                                })),
                        )
                    }),
            );
        }
        if let Some(target) = draft.created.clone() {
            let key = key.clone();
            let revision = draft.revision;
            actions = actions.child(
                Button::new("open-created")
                    .small()
                    .w_full()
                    .label("Open created chat")
                    .icon(AppIcon::Chats.asset())
                    .on_click(cx.listener(move |_, _, _, cx| {
                        cx.emit(EditorEvent::OpenCreated {
                            key: key.clone(),
                            revision,
                            target: target.clone(),
                        })
                    })),
            );
        }
        if !draft.recovered.is_empty() {
            let revision = draft.recovery_revision;
            let recovery_key = key.clone();
            let copy_key = key.clone();
            actions = actions.child(
                div()
                    .v_flex()
                    .gap_2()
                    .child(
                        Button::new("copy-recovered")
                            .small()
                            .w_full()
                            .label("Copy recovered text")
                            .icon(AppIcon::Copy.asset())
                            .on_click(cx.listener(move |view, _, _, cx| {
                                if let Some(draft) = view.cache.get(&copy_key) {
                                    cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(
                                        draft.recovered.join("\n\n"),
                                    ));
                                }
                            })),
                    )
                    .child(
                        Button::new("remove-recovered")
                            .small()
                            .w_full()
                            .label("Remove recovered text")
                            .icon(AppIcon::Close.asset())
                            .on_click(cx.listener(move |view, _, _, _| {
                                if let Some(client) = &view.client {
                                    client.command(WriteCommand::ClearRecovery {
                                        key: recovery_key.clone(),
                                        revision,
                                    });
                                }
                            })),
                    ),
            );
        }
        if discardable {
            let discard_key = key.clone();
            actions = actions.child(
                div().v_flex().w_full().child(
                    Button::new("discard-draft")
                        .small()
                                    .w_full()
                        .ghost()
                        .label("Discard draft")
                        .disabled(self.question_blocks_discard(cx))
                        .tooltip("Discard applies to the ordinary message draft, not a separate question reply.")
                        .icon(AppIcon::Close.asset())
                        .accessibility_label("Discard draft and copy its text to the clipboard")
                        .on_click(
                            cx.listener(move |view, _, window, cx| {
                                if view.selected.as_ref() == Some(&discard_key) {
                                    view.discard_draft(window, cx);
                                }
                            }),
                        ),
                ),
            );
        }

        actions.into_any_element()
    }
}
