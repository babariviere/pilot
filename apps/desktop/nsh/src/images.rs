//! Stored conversation images. Upstream Image, Button, Dialog and axis Scrolls;
//! no image loader, raster decoder, custom scroll engine or application cache.
use super::*;
use pilot_desktop::nsh_adapter::{ImagePreview, InlineImage};
use std::{
    rc::Rc,
    sync::atomic::{AtomicBool, Ordering},
};

pub(super) type CopyImage = Arc<dyn Fn(&ImagePreview) + Send + Sync>;
type Prepared = Signal<Option<Result<ImagePreview, &'static str>>>;

fn current(ui: Ui, location: &Location, image: &InlineImage) -> bool {
    ui.adapter.with(|a| a.image_current(location, image))
}
fn action(title: &'static str, text: &'static str, run: impl Fn() + 'static) -> impl IntoElement {
    button()
        .accessibility_label(title)
        .min_h(px(28.))
        .px(px(7.))
        .on_press(run)
        .child(label(text, 12.).text_color(META))
}

pub(super) fn row(ui: Ui, location: Location, source: InlineImage) -> impl IntoElement {
    let source = stored(source);
    let expand_label = source.with(|s| format!("Expand image, block {}", s.block()));
    let result: Prepared = signal(None);
    let display_problem = signal(None::<&'static str>);
    let loaded = signal(false);
    let stop = Arc::new(AtomicBool::new(false));
    let cancelled = stop.clone();
    cleanup(move || cancelled.store(true, Ordering::Release));
    if source.with(|s| s.problem().is_none()) {
        let image = source.get();
        let own = location.clone();
        let task = spawn(async move {
            let prepared = image.preview(stop.clone()).await;
            if !stop.load(Ordering::Acquire) && current(ui, &own, &image) {
                result.set(Some(prepared));
            }
        });
        let _task = stored(task);
    }
    let selected = signal(false);
    let expand = element_ref();
    let own = location.clone();
    let identity = location.clone();
    let copy = location.clone();
    let reader_location = location.clone();
    let problem = computed(move || {
        if let Some(error) = display_problem.get() {
            return Some(error);
        }
        source
            .with(|s| s.problem())
            .or_else(|| result.with(|r| r.as_ref().and_then(|r| r.as_ref().err().copied())))
    });
    let size = source.with(|s| s.size());
    let (width, height) = size.unwrap_or((440, 192));
    let ratio = width as f32 / height as f32;
    view()
        .min_w(px(0.))
        .gap(px(4.))
        .group()
        .child(
            view()
                .flex_row()
                .justify_end()
                .h(px(28.))
                .opacity(0_f32)
                .group_hover(|s| s.opacity(1.))
                .group_focus_within(|s| s.opacity(1.))
                .child(action("Copy source identity", "Source", move || {
                    source.with(|s| {
                        if current(ui, &identity, s) {
                            set_clipboard(s.identity());
                        }
                    });
                }))
                .child(
                    button()
                        .accessibility_label("Copy image")
                        .min_h(px(28.))
                        .px(px(7.))
                        .disabled(move || !result.with(|r| matches!(r, Some(Ok(_)))))
                        .on_press(move || {
                            if source.with(|s| current(ui, &copy, s)) {
                                result.with(|r| {
                                    if let Some(Ok(r)) = r {
                                        ui.copy_image.with(|copy| copy(r));
                                    }
                                });
                            }
                        })
                        .child(label("Copy", 12.).text_color(META)),
                ),
        )
        .child(
            button()
                .accessibility_label(expand_label)
                .element_ref(&expand)
                .disabled(move || ui.composing.get() || !result.with(|r| matches!(r, Some(Ok(_)))))
                .on_press(move || {
                    if !ui.composing.get_untracked() && source.with(|s| current(ui, &own, s)) {
                        selected.set(true);
                    }
                })
                .w_full()
                .max_w(px((width as f32).min(720. * ratio).max(48.)))
                .aspect_ratio(ratio)
                .min_h(px(48.))
                .relative()
                .rounded(px(6.))
                .overflow_hidden()
                .child(when(
                    move || result.with(|r| matches!(r, Some(Ok(_)))),
                    move || {
                        image(move || {
                            result.with(|r| {
                                r.as_ref()
                                    .and_then(|r| r.as_ref().ok())
                                    .map(|r| SharedString::from(r.uri.as_ref().clone()))
                                    .unwrap_or_default()
                            })
                        })
                        .test_id("inline-image-pixels")
                        .label(move || {
                            source.with(|s| {
                                format!(
                                    "Inline image, block {}, {}",
                                    s.block(),
                                    if loaded.get() { "ready" } else { "loading" }
                                )
                            })
                        })
                        .absolute()
                        .inset_0()
                        .w_full()
                        .h_full()
                        .on_load(
                            move |actual: &nsh_core::geometry::Size<
                                nsh_core::geometry::DevicePixels,
                            >| {
                                let valid = result.with_untracked(|r| {
                                    r.as_ref().and_then(|r| r.as_ref().ok()).is_some_and(|r| {
                                        r.width as f32 == actual.width.0 as f32
                                            && r.height as f32 == actual.height.0 as f32
                                    })
                                });
                                if valid {
                                    loaded.set(true);
                                } else {
                                    display_problem
                                        .set(Some("Image display geometry unavailable."));
                                }
                            },
                        )
                        .on_error(move |_: &str| {
                            display_problem.set(Some("Image display unavailable."))
                        })
                        .object_fit(nsh_core::ResizeMode::Contain)
                    },
                ))
                .child(when(
                    move || !loaded.get() || problem.get().is_some(),
                    move || {
                        label(move || problem.get().unwrap_or("Loading image…"), 12.)
                            .text_color(META)
                            .absolute()
                            .top(px(8.))
                            .left(px(8.))
                    },
                )),
        )
        .child(when(
            move || source.with(|s| s.first_frame()),
            || label("First frame only", 11.).text_color(META),
        ))
        .child(when(
            move || selected.get(),
            move || {
                reader(
                    ui,
                    reader_location.clone(),
                    source.get(),
                    result,
                    move || {
                        selected.set(false);
                        expand.focus();
                    },
                )
            },
        ))
}

fn reader(
    ui: Ui,
    location: Location,
    source: InlineImage,
    prepared: Prepared,
    close: impl Fn() + Clone + 'static,
) -> impl IntoElement {
    let source = stored(source);
    let viewport = signal((1_f32, 1_f32));
    let display_ready = signal(false);
    let display_problem = signal(None::<&'static str>);
    let scale = signal(None::<f32>);
    let horizontal = element_ref();
    let vertical = element_ref();
    let offset = signal((0_f32, 0_f32));
    let mouse = Rc::new(std::cell::Cell::new(
        None::<nsh_core::geometry::Point<nsh_core::geometry::Points>>,
    ));
    let mouse_enter = mouse.clone();
    let mouse_leave = mouse.clone();
    let pan = move |dx: f32, dy: f32| {
        let (x, y) = offset.get_untracked();
        let next = ((x + dx).max(0.), (y + dy).max(0.));
        offset.set(next);
        horizontal.scroll_to(nsh_core::geometry::point(px(next.0), px(0.)), false);
        vertical.scroll_to(nsh_core::geometry::point(px(0.), px(next.1)), false);
    };
    let size = computed(move || {
        prepared.with(|p| {
            p.as_ref()
                .and_then(|r| r.as_ref().ok())
                .map(|r| {
                    (
                        r.width as f32 / pixel_ratio(),
                        r.height as f32 / pixel_ratio(),
                    )
                })
                .unwrap_or((1., 1.))
        })
    });
    let fit = computed(move || {
        let (w, h) = size.get();
        let (vw, vh) = viewport.get();
        (vw / w).min(vh / h).clamp(0.1, 8.)
    });
    let factor = computed(move || scale.get().unwrap_or_else(|| fit.get()));
    let reset_pan = move || {
        offset.set((0., 0.));
        horizontal.scroll_to(nsh_core::geometry::point(px(0.), px(0.)), false);
        vertical.scroll_to(nsh_core::geometry::point(px(0.), px(0.)), false);
    };
    let copy_location = location.clone();
    let copy_source_location = location.clone();
    let keyboard_copy_location = location.clone();
    on_key("mod+c", move |_| {
        if source.with(|s| current(ui, &keyboard_copy_location, s)) {
            prepared.with(|p| {
                if let Some(Ok(p)) = p {
                    ui.copy_image.with(|copy| copy(p));
                }
            });
        }
    });
    let zoom = move |command: &'static str| {
        if !source.with(|s| current(ui, &location, s)) {
            return;
        }
        scale.set(match command {
            "in" => Some((factor.get_untracked() * 1.25).clamp(0.1, 8.)),
            "out" => Some((factor.get_untracked() / 1.25).clamp(0.1, 8.)),
            "actual" => Some(1.),
            _ => None,
        });
        after_answer(reset_pan);
    };
    let zoom = Rc::new(zoom);
    for (key, command) in [
        ("mod+=", "in"),
        ("mod+shift+=", "in"),
        ("mod+-", "out"),
        ("mod+0", "reset"),
        ("mod+1", "actual"),
    ] {
        let zoom = zoom.clone();
        on_key(key, move |_| zoom(command));
    }
    for (key, dx, dy) in [
        ("alt+left", -48., 0.),
        ("alt+right", 48., 0.),
        ("alt+up", 0., -48.),
        ("alt+down", 0., 48.),
    ] {
        on_key(key, move |_| {
            pan(dx, dy);
        });
    }
    let close_button = close.clone();
    nsh_base::dialog()
        .animation(nsh_core::ModalAnimation::None)
        .presentation(nsh_core::ModalPresentation::FullScreen)
        .on_cancel(close)
        .child(
            view()
                .test_id("image-reader")
                .flex_1()
                .min_h(px(0.))
                .bg(PAGE)
                .p(px(16.))
                .gap(px(8.))
                .child(
                    view()
                        .flex_row()
                        .flex_wrap()
                        .items_center()
                        .gap(px(4.))
                        .children(
                            [
                                ("Fit", "Fit image", "fit"),
                                ("100%", "Actual size (100%)", "actual"),
                                ("−", "Zoom out", "out"),
                                ("+", "Zoom in", "in"),
                                ("Reset", "Reset image", "reset"),
                            ]
                            .into_iter()
                            .map(|(text, title, command)| {
                                let zoom = zoom.clone();
                                action(title, text, move || zoom(command)).into_element()
                            })
                            .collect::<Vec<_>>(),
                        )
                        .child(
                            label(move || format!("{}%", (factor.get() * 100.).round()), 11.)
                                .text_color(META),
                        )
                        .child(action("Copy image in reader", "Copy", move || {
                            if source.with(|s| current(ui, &copy_location, s)) {
                                prepared.with(|p| {
                                    if let Some(Ok(p)) = p {
                                        ui.copy_image.with(|copy| copy(p));
                                    }
                                });
                            }
                        }))
                        .child(action("Copy image source", "Copy source", move || {
                            if source.with(|s| current(ui, &copy_source_location, s)) {
                                prepared.with(|p| {
                                    if let Some(Ok(p)) = p {
                                        set_clipboard(p.original.as_ref().clone());
                                    }
                                });
                            }
                        }))
                        .child(view().flex_1())
                        .child(action("Close image (Escape)", "Close", close_button)),
                )
                .child(
                    view()
                        .flex_1()
                        .min_h(px(0.))
                        .min_w(px(0.))
                        .relative()
                        .overflow_hidden()
                        .on_mouse_enter(move |e: &nsh_core::MouseEvent| {
                            mouse_enter.set(Some(e.page_position))
                        })
                        .on_mouse_leave(move |_: &nsh_core::MouseEvent| mouse_leave.set(None))
                        .on_mouse_move(move |e: &nsh_core::MouseEvent| {
                            let previous = mouse.replace(Some(e.page_position));
                            if e.pressed_button == Some(nsh_core::MouseButton::Middle)
                                && let Some(previous) = previous
                            {
                                pan(
                                    previous.x.0 - e.page_position.x.0,
                                    previous.y.0 - e.page_position.y.0,
                                );
                            }
                        })
                        .on_layout(
                            move |bounds: &nsh_core::geometry::Bounds<
                                nsh_core::geometry::Points,
                            >| {
                                viewport.set((
                                    bounds.size.width.0.max(1.),
                                    bounds.size.height.0.max(1.),
                                ));
                            },
                        )
                        .child(
                            scroll()
                                .test_id("image-pan-x")
                                .horizontal()
                                .element_ref(&horizontal)
                                .w_full()
                                .h_full()
                                .on_scroll(move |e: &nsh_core::element::ScrollEvent| {
                                    offset.update(|o| o.0 = e.offset.x.0)
                                })
                                .child(
                                    scroll()
                                        .test_id("image-pan-y")
                                        .element_ref(&vertical)
                                        .w(move || {
                                            px((size.get().0 * factor.get()).max(viewport.get().0))
                                        })
                                        .h_full()
                                        .on_scroll(move |e: &nsh_core::element::ScrollEvent| {
                                            offset.update(|o| o.1 = e.offset.y.0)
                                        })
                                        .child(
                                            view()
                                                .min_h(move || px(viewport.get().1))
                                                .items_center()
                                                .justify_center()
                                                .child(
                                                    image(move || {
                                                        prepared.with(|p| {
                                                            p.as_ref()
                                                                .and_then(|r| r.as_ref().ok())
                                                                .map(|r| {
                                                                    SharedString::from(
                                                                        r.uri.as_ref().clone(),
                                                                    )
                                                                })
                                                                .unwrap_or_default()
                                                        })
                                                    })
                                                    .test_id("reader-image-pixels")
                                                    .label("Reader image pixels")
                                                    .on_load(move |_: &nsh_core::geometry::Size<nsh_core::geometry::DevicePixels>|display_ready.set(true))
                                                    .on_error(move |_: &str|display_problem.set(Some("Image display unavailable.")))
                                                    .w(move || px(size.get().0 * factor.get()))
                                                    .h(move || px(size.get().1 * factor.get()))
                                                    .object_fit(nsh_core::ResizeMode::Contain),
                                                ),
                                        ),
                                ),
                        )
                        .child(when(move || !display_ready.get() || display_problem.get().is_some(), move || {
                            label(move || display_problem.get().unwrap_or("Loading image…"),12.).text_color(META).absolute().top(px(8.)).left(px(8.))
                        })),
                ),
        )
}
