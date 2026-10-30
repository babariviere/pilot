//! Explicit native link activation. Targets remain owned by the exact reader scene.
use super::*;

struct Activation {
    generation: u64,
    version: u64,
    inline: bool,
    revision: Arc<crate::artifact_model::Revision>,
    scene: Arc<crate::visual_scene::Scene>,
    path: String,
}

impl ArtifactPane {
    fn link_destination(&self, activation: &Activation) -> Option<reqwest::Url> {
        let current = self.snapshot.revision.as_ref()?;
        if self.source
            || self.generation != activation.generation
            || self.snapshot.version != activation.version
            || self.inline != activation.inline
            || !Arc::ptr_eq(current, &activation.revision)
            || !self.reference.as_ref()?.same_revision(&current.reference)
            || !Arc::ptr_eq(self.snapshot.scene.as_ref()?, &activation.scene)
        {
            return None;
        }
        match crate::external_links::route(activation.scene.links.get(&activation.path)?) {
            crate::external_links::Route::Web(url) => Some(url),
            _ => None,
        }
    }

    pub(super) fn link(&self, value: &Value, path: &str, cx: &Context<Self>) -> AnyElement {
        let label = value["label"].as_str().unwrap_or("");
        let activation = self
            .snapshot
            .revision
            .as_ref()
            .zip(self.snapshot.scene.as_ref())
            .map(|(revision, scene)| Activation {
                generation: self.generation,
                version: self.snapshot.version,
                inline: self.inline,
                revision: revision.clone(),
                scene: scene.clone(),
                path: path.into(),
            });
        let Some(activation) = activation.filter(|a| self.link_destination(a).is_some()) else {
            return div()
                .v_flex()
                .id(SharedString::from(format!("visual-link-refused-{path}")))
                .test_support()
                .child(self.text(path.into(), label.into()))
                .child(Self::note(crate::external_links::REFUSED))
                .into_any_element();
        };
        let owner = cx.weak_entity();
        // Base Link owns native pointer/keyboard/focus semantics. The legacy
        // component Link opens href directly and is pointer-only, so never use it.
        let mut hash = DefaultHasher::new();
        label.hash(&mut hash);
        // A held pointer/key gesture must not transfer to a replacement scene
        // merely because the new resource occupies the same node path.
        let target_id = format!(
            "visual-link-target-{}-{}-{}-{:p}-{path}",
            self.generation,
            self.snapshot.version,
            self.inline,
            Arc::as_ptr(&activation.scene)
        );
        div()
            .id(SharedString::from(format!("visual-link-{path}")))
            .test_support()
            .child(
                gpui_kit::base::Link::new(SharedString::from(target_id))
                    .accessibility_label(label.to_owned())
                    .text_color(cx.theme().link)
                    .text_decoration_1()
                    .text_decoration_color(cx.theme().link.opacity(0.5))
                    .hover(|s| s.text_color(cx.theme().link.opacity(0.8)))
                    .focus_visible(|s| s.bg(cx.theme().secondary))
                    .cursor_pointer()
                    .on_activate(move |event, window, cx| {
                        if event.is_right_click()
                            || event.is_middle_click()
                            || (!matches!(event, gpui_kit::ClickEvent::Keyboard(_))
                                && !gpui_kit::base::TextSelection::selected_text(window, cx)
                                    .is_empty())
                        {
                            return;
                        }
                        let _ = owner.update(cx, |pane, cx| {
                            if let Some(url) = pane.link_destination(&activation) {
                                crate::external_links::open(&url, cx);
                            }
                        });
                    })
                    .child(SelectableText::new(
                        SharedString::from(format!(
                            "visual-link-label-{}-{}-{path}",
                            self.generation,
                            hash.finish()
                        )),
                        label.to_owned(),
                    )),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::TestAppContext;

    fn scene(href: &str) -> crate::visual_scene::Scene {
        crate::visual_scene::Scene::parse(
            json!({"api":1,"root":{"type":"link","label":"Resource","href":href}}),
        )
        .unwrap()
    }

    #[test]
    fn schema_preserves_source_targets_and_refuses_non_web_schemes() {
        for href in [
            "https://example.com",
            "HTTP://example.com/a",
            "https://user:password@example.com",
            "https://example.com/%0a",
        ] {
            assert_eq!(scene(href).links["0"], href);
        }
        for href in [
            "file:///tmp/a",
            "javascript:alert(1)",
            "pilot://chat/a",
            "slack://open",
            "linear://issue/a",
        ] {
            assert!(
                crate::visual_scene::Scene::parse(
                    json!({"api":1,"root":{"type":"link","label":"Resource","href":href}})
                )
                .is_err(),
                "{href}"
            );
        }
    }

    #[gpui_kit::test]
    fn exact_revision_scene_owner_lifetime_and_presentation_fence_activation(
        cx: &mut TestAppContext,
    ) {
        let pane = cx.new(|cx| {
            let mut p = ArtifactPane::new();
            p.preview(
                Reference {
                    id: "a".into(),
                    session: "owner".into(),
                    revision: 1,
                    title: "Resource".into(),
                    kind: "visual".into(),
                },
                "source".into(),
                scene("https://linear.app/team/issue/ABC-1"),
                cx,
            );
            p
        });
        pane.update(cx, |p, cx| {
            let a = Activation {
                generation: p.generation,
                version: p.snapshot.version,
                inline: p.inline,
                revision: p.snapshot.revision.clone().unwrap(),
                scene: p.snapshot.scene.clone().unwrap(),
                path: "0".into(),
            };
            assert_eq!(
                p.link_destination(&a).unwrap().as_str(),
                "https://linear.app/team/issue/ABC-1"
            );
            p.source = true;
            assert!(p.link_destination(&a).is_none());
            p.source = false;
            p.inline = true;
            assert!(p.link_destination(&a).is_none());
            p.inline = false;
            p.snapshot.version += 1;
            assert!(p.link_destination(&a).is_none());
            p.snapshot.version -= 1;
            p.snapshot.scene = Some(Arc::new(scene("https://example.com/replaced")));
            assert!(p.link_destination(&a).is_none());
            p.snapshot.scene = Some(a.scene.clone());
            p.reference.as_mut().unwrap().revision += 1;
            assert!(p.link_destination(&a).is_none());
            p.reference.as_mut().unwrap().revision -= 1;
            p.context(Some("another-owner".into()), Arc::new(vec![]), cx);
            assert!(p.link_destination(&a).is_none());
        });
    }
}
