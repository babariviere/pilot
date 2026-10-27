//! Source-indexed, compiled component examples. Only this owner has state/events.
//! No Local client, persistence, fetch, submit handler, timer or automatic action.
use crate::ui::{
    self, Action, FieldLayout, FieldRow, IconRole, Notice, ResourceLabel, Space, Surface, Text,
    Tone,
};
use gpui_kit::{
    AppContext, Bounds, Context, Entity, EntityInputHandler, Focusable, HeadlessAppContext,
    InteractiveElement, IntoElement, ParentElement, Render, SharedString, Styled, Subscription,
    TestSupportExt, Window, WindowBounds, WindowOptions,
    component::{
        ActiveTheme, Disableable, Selectable, Sizable, StyledExt, Theme, ThemeMode,
        button::{Button, ButtonVariants},
        input::{Input, InputEvent, InputState},
    },
    div, px, size,
    test::TestWindowExt,
};
use std::time::Duration;

struct Catalogue {
    input: Entity<InputState>,
    clicks: usize,
    edits: usize,
    loading: bool,
    _input_events: Subscription,
}
impl Catalogue {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("Type an example label"));
        let events = cx.subscribe(&input, |this, _, event, cx| {
            if matches!(event, InputEvent::Change) {
                this.edits += 1;
                cx.notify();
            }
        });
        Self {
            input,
            clicks: 0,
            edits: 0,
            loading: true,
            _input_events: events,
        }
    }
    fn clicked(&mut self, cx: &mut Context<Self>) {
        self.clicks += 1;
        cx.notify();
    }
}
impl Render for Catalogue {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let layout = if window.viewport_size().width < px(800.) {
            FieldLayout::Stacked
        } else {
            FieldLayout::Inline
        };
        let actions = div()
            .v_flex()
            .gap(px(Space::CONTROL))
            .child(ui::heading("catalog-actions", "Actions", Text::Headline))
            .child(
                div()
                    .h_flex()
                    .flex_wrap()
                    .gap(px(Space::CONTROL))
                    .child(
                        ui::action("catalog-primary", "Run example", Action::Primary)
                            .on_click(cx.listener(|this, _, _, cx| this.clicked(cx))),
                    )
                    .child(
                        ui::action("catalog-secondary", "Secondary", Action::Secondary)
                            .on_click(cx.listener(|this, _, _, cx| this.clicked(cx))),
                    )
                    .child(
                        ui::action("catalog-quiet", "Quiet", Action::Quiet)
                            .on_click(cx.listener(|this, _, _, cx| this.clicked(cx))),
                    )
                    .child(
                        ui::action("catalog-danger", "Danger example", Action::Danger)
                            .on_click(cx.listener(|this, _, _, cx| this.clicked(cx))),
                    ),
            )
            .child(
                div()
                    .h_flex()
                    .flex_wrap()
                    .gap(px(Space::CONTROL))
                    .child(
                        ui::action("catalog-disabled", "Disabled example", Action::Quiet)
                            .disabled(true)
                            .on_click(cx.listener(|this, _, _, cx| this.clicked(cx))),
                    )
                    .child(
                        ui::action("catalog-loading", "Pending example", Action::Secondary)
                            .loading(self.loading)
                            .on_click(cx.listener(|this, _, _, cx| this.clicked(cx))),
                    )
                    .child(
                        ui::action("catalog-selected", "Selected example", Action::Quiet)
                            .selected(true),
                    )
                    .child(
                        ui::icon_action(
                            "catalog-icon-action",
                            "Copy example",
                            IconRole::Copy,
                            Action::Quiet,
                        )
                        .on_click(cx.listener(|this, _, _, cx| this.clicked(cx))),
                    ),
            )
            .child(ui::text(
                Text::Caption,
                SharedString::from(format!(
                    "Example clicks: {} · committed edits: {}",
                    self.clicks, self.edits
                )),
            ));
        let fields = div()
            .v_flex()
            .gap(px(Space::SIDEBAR))
            .child(ui::heading("catalog-fields", "Fields", Text::Headline))
            .child(
                FieldRow::new(
                    "catalog-field",
                    "Example name with a long descriptive label",
                    Input::new(&self.input)
                        .id("catalog-input")
                        .aria_label("Example name"),
                )
                .description(
                    "Unicode and native preedit stay in the owner's existing Kit input entity.",
                )
                .layout(layout),
            )
            .child(
                FieldRow::new(
                    "catalog-disabled-field",
                    "Disabled field example",
                    ui::action("catalog-disabled-control", "Unavailable", Action::Secondary)
                        .disabled(true),
                )
                .description("The actual control is disabled, not only its label.")
                .validation("Example validation: choose a value first.", Tone::Warning)
                .layout(layout),
            );
        let resource = Button::new("catalog-resource")
            .ghost()
            .small()
            .w_full()
            .h(px(Space::ROW))
            .accessibility_label("Long example project, 資料 👩‍💻, 4 loaded chats")
            .child(
                ResourceLabel::new(
                    "Long example project with a deliberately extensive name, 資料 👩‍💻",
                )
                .detail("4 loaded chats · synthetic content only")
                .icon(IconRole::Project),
            )
            .on_click(cx.listener(|this, _, _, cx| this.clicked(cx)));
        let surfaces = ui::surface(Surface::Tray, cx)
            .id("catalog-tray")
            .test_support()
            .h(px(76.))
            .w_full()
            .rounded(px(ui::Radius::TRAY))
            .v_flex()
            .justify_center()
            .px(px(Space::CONTROL))
            .child(
                ui::surface(Surface::Card, cx)
                    .id("catalog-card")
                    .test_support()
                    .h(px(34.))
                    .w_full()
                    .rounded(px(ui::Radius::CONTROL))
                    .v_flex()
                    .justify_center()
                    .px(px(Space::CONTROL))
                    .child(ui::text(Text::Body, "Opaque editor surface example")),
            );
        let content = ui::page()
            .child(
                ui::header("catalog-title", "Components", Text::Display).child(
                    ui::text(
                        Text::Caption,
                        "Synthetic native examples, no data or settings access",
                    )
                    .text_color(cx.theme().muted_foreground),
                ),
            )
            .child(actions)
            .child(fields)
            .child(
                div()
                    .v_flex()
                    .gap(px(Space::CONTROL))
                    .child(ui::heading(
                        "catalog-resources",
                        "Resources",
                        Text::Headline,
                    ))
                    .child(resource),
            )
            .child(
                div()
                    .v_flex()
                    .gap(px(Space::CONTROL))
                    .child(ui::heading("catalog-surfaces", "Surfaces", Text::Headline))
                    .child(surfaces),
            )
            .child(ui::rule(window, cx))
            .child(
                div()
                    .v_flex()
                    .gap(px(Space::SIDEBAR))
                    .child(
                        Notice::new("Empty example")
                            .detail("No items in this synthetic section.")
                            .tone(Tone::Quiet),
                    )
                    .child(Notice::new("Loading example…").tone(Tone::Quiet))
                    .child(
                        Notice::new("Example error")
                            .detail("Nothing was fetched. This is a synthetic status sample.")
                            .tone(Tone::Error),
                    )
                    .child(Notice::new("Example success").tone(Tone::Success)),
            );
        ui::surface(Surface::Page, cx)
            .size_full()
            .min_w_0()
            .text_color(cx.theme().foreground)
            .child(content)
    }
}

fn settle(cx: &mut HeadlessAppContext, h: gpui_kit::AnyWindowHandle) {
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| w.draw(cx).clear(cx))
        .unwrap();
}
pub fn run_catalog_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_CATALOG_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    // Identity faces are embedded and resolved directly, never via another family.
    cx.update(|cx| {
        use crate::appearance::{CODE_FONT, DISPLAY_FONT, UI_FONT};
        use gpui_kit::component::ActiveTheme;
        assert_eq!(cx.theme().font_family.as_ref(), UI_FONT);
        assert_eq!(cx.theme().mono_font_family.as_ref(), CODE_FONT);
        let fallback = cx
            .text_system()
            .resolve_font(&gpui_kit::font("Pilot missing family"));
        let mut faces = Vec::new();
        for (family, weight) in [
            (UI_FONT, gpui_kit::FontWeight::NORMAL),
            (UI_FONT, gpui_kit::FontWeight::SEMIBOLD),
            (DISPLAY_FONT, gpui_kit::FontWeight::SEMIBOLD),
            (CODE_FONT, gpui_kit::FontWeight::NORMAL),
        ] {
            let mut face = gpui_kit::font(family);
            face.weight = weight;
            let id = cx.text_system().resolve_font(&face);
            assert!(
                id != fallback && !faces.contains(&id),
                "{family} {weight:?}"
            );
            faces.push(id);
        }
    });
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            cx.update(|cx| Theme::change(mode, None, cx));
            let (h, view) = cx
                .update(|cx| {
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Default::default(),
                                size(px(width), px(1280.)),
                            ))),
                            show: false,
                            focus: false,
                            ..Default::default()
                        },
                        cx,
                        |w, cx| cx.new(|cx| Catalogue::new(w, cx)),
                    )
                })
                .unwrap();
            settle(cx, h);
            let (glyph, tray, card) = cx
                .update_window(h, |_, w, cx| {
                    for id in [
                        "catalog-title",
                        "catalog-field",
                        "catalog-input",
                        "catalog-disabled-field",
                        "catalog-resource",
                        "resource-title",
                        "resource-detail",
                        "catalog-tray",
                        "catalog-card",
                    ] {
                        let b = w.find(id).bounds();
                        assert!(
                            b.size.width > px(0.)
                                && b.size.height > px(0.)
                                && b.left() >= px(0.)
                                && b.right() <= px(width)
                                && b.bottom() <= px(1280.),
                            "{id}: {b:?}"
                        );
                    }
                    let glyph = w.find("resource-icon").bounds();
                    let label = w.find("resource-title").bounds();
                    let row = w.find("catalog-resource").bounds();
                    assert_eq!(glyph.size, size(w.rem_size(), w.rem_size()));
                    assert!(glyph.left() >= row.left() && glyph.left() - row.left() < px(12.));
                    assert!((label.left() - glyph.right() - px(Space::CONTROL)).abs() < px(0.1));
                    assert!(label.right() <= row.right());
                    let tray = w.find("catalog-tray").bounds();
                    let card = w.find("catalog-card").bounds();
                    assert_eq!(tray.size.height, px(76.));
                    assert_eq!(card.size.height, px(34.));
                    w.click("catalog-disabled", cx);
                    w.click("catalog-loading", cx);
                    assert_eq!(view.read(cx).clicks, 0, "actual disabled/loading guards");
                    w.click("catalog-primary", cx);
                    assert_eq!(view.read(cx).clicks, 1);
                    w.focus_next(cx);
                    w.press("space", cx);
                    assert_eq!(view.read(cx).clicks, 2, "native keyboard callback");
                    let input = view.read(cx).input.clone();
                    input.focus_handle(cx).focus(w, cx);
                    w.input("資料 👩‍💻 e\u{301} ", cx);
                    input.update(cx, |q, cx| {
                        q.replace_and_mark_text_in_range(None, "にほん", Some(3..3), w, cx)
                    });
                    view.update(cx, |v, cx| {
                        v.loading = false;
                        cx.notify();
                    });
                    (glyph, tray, card)
                })
                .unwrap();
            settle(cx, h);
            cx.update_window(h, |_, w, cx| {
                let input = view.read(cx).input.clone();
                let id = input.entity_id();
                assert!(input.focus_handle(cx).is_focused(w));
                input.update(cx, |q, cx| {
                    assert!(
                        q.marked_text_range(w, cx).is_some(),
                        "owner rerender must retain preedit"
                    );
                    q.replace_text_in_range(None, "にほん", w, cx);
                });
                assert_eq!(view.read(cx).input.entity_id(), id);
                assert_eq!(input.read(cx).value().as_ref(), "資料 👩‍💻 e\u{301} にほん");
                assert!(view.read(cx).edits > 0, "real native Change notifications");
                assert_eq!(view.read(cx).clicks, 2, "no implicit submit from fields");
            })
            .unwrap();
            settle(cx, h);
            let image = cx.capture_screenshot(h).unwrap();
            let scale = image.width() as f32 / width;
            crate::icon_probe::assert_painted(glyph, scale, "resource Project glyph", |x, y| {
                image.get_pixel(x, y).0
            });
            let sample = |b: Bounds<gpui_kit::Pixels>| {
                image
                    .get_pixel(
                        ((f32::from(b.right()) - 4.) * scale) as u32,
                        (f32::from(b.center().y) * scale) as u32,
                    )
                    .0
            };
            assert_ne!(
                sample(tray),
                sample(card),
                "opaque Card/Tray roles must differ"
            );
            assert_eq!(sample(card)[3], 255);
            if let Some(dir) = &captures {
                image
                    .save(dir.join(format!("catalog-{}-{}.png", width as u32, mode.name())))
                    .unwrap();
            }
            cx.advance_clock(Duration::from_millis(800));
            cx.run_until_parked();
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
            println!(
                "component catalog {width} {}: bounds/glyph/contrast/disabled/loading/keyboard/Unicode/preedit/rerender/commit pass; synthetic only",
                mode.name()
            );
        }
    }
}
