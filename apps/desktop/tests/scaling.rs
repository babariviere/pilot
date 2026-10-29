//! Opt-in isolated native TextView observations, not visible pacing or a Swift comparison.
use gpui_kit::test::TestWindowExt;
use gpui_kit::{
    AppContext, Bounds, Context, Entity, HeadlessAppContext, InteractiveElement, IntoElement,
    ParentElement, Render, StatefulInteractiveElement, Styled, Window, WindowBounds, WindowOptions,
    base::TextSelection,
    component::text::{SelectionFormat, TextView, TextViewState},
    div, px, size,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Instant};

struct Probe {
    text: Entity<TextViewState>,
    source_copy: bool,
}
impl Render for Probe {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().id("probe").size_full().overflow_y_scroll().child(
            TextView::new(&self.text)
                .selection_format(if self.source_copy {
                    SelectionFormat::Source
                } else {
                    SelectionFormat::Plain
                })
                .selectable(true)
                .scrollable(false)
                .stream_fade(true)
                .on_link_click(|_, _, _, _| {}),
        )
    }
}
fn fixture(kind: &str, bytes: usize) -> String {
    let (prefix, suffix, unit) = match kind {
        "paragraphs" => (
            "",
            "",
            format!(
                "Paragraph **bold** and `code`, 日本語 👩🏽‍💻. {}\n\n",
                "x".repeat(440)
            ),
        ),
        "line" => ("", "", "word 日本語 é 👩🏽‍💻 ".into()),
        "fence" => (
            "```rust\n",
            "\n```",
            "let value = 42; // synthetic\n".into(),
        ),
        "open-fence" => ("```rust\n", "", "let value = 42; // synthetic\n".into()),
        _ => panic!("Unknown synthetic case"),
    };
    let capacity = bytes - prefix.len() - suffix.len();
    let mut source = String::with_capacity(bytes);
    source.push_str(prefix);
    for _ in 0..capacity / unit.len() {
        source.push_str(&unit);
    }
    let remaining = capacity % unit.len();
    let mut end = remaining;
    while !unit.is_char_boundary(end) {
        end -= 1;
    }
    source.push_str(&unit[..end]);
    source.push_str(&" ".repeat(remaining - end));
    source.push_str(suffix);
    assert_eq!(source.len(), bytes);
    source
}
fn millis(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.
}
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    assert_eq!(
        args.len(),
        2,
        "scaling CASE BYTES; max1MiB, no accounts/network/state"
    );
    let kind = &args[0];
    let bytes: usize = args[1].parse().unwrap();
    assert!((8192..=1_048_576).contains(&bytes));
    let mut source = fixture(kind, bytes - 400);
    let source_hash = Sha256::digest(source.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let mut cx = HeadlessAppContext::with_platform(
        gpui_kit::platform::current_platform(true).text_system(),
        Arc::new(pilot_desktop::ChromeAssets),
        gpui_kit::platform::current_headless_renderer,
    );
    cx.update(|cx| {
        gpui_kit::init(cx);
        pilot_desktop::init_appearance(cx);
    });
    let ready = Instant::now();
    eprintln!("scaling phase: construct");
    let (handle, view) = cx
        .update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(960.), px(760.)),
                    ))),
                    focus: false,
                    show: false,
                    ..Default::default()
                },
                cx,
                |_, cx| {
                    cx.new(|cx| Probe {
                        source_copy: false,
                        text: cx.new(|cx| {
                            TextViewState::markdown(&source, cx)
                                .images_enabled(false)
                                .retain_selection_on_unmount(true, cx)
                        }),
                    })
                },
            )
        })
        .unwrap();
    let construction_ms = millis(ready);
    eprintln!("scaling phase: initial drain");
    cx.run_until_parked();
    assert!(cx.update(|cx| view.read(cx).text.read(cx).rendered_text().source() == source));
    let ready_wall_ms = millis(ready);
    eprintln!("scaling phase: first frame");
    let frame = Instant::now();
    cx.update_window(handle, |_, window, cx| window.render_frame(cx))
        .unwrap();
    let first_frame_cpu_ms = millis(frame);
    let mut warm = Vec::new();
    for _ in 0..3 {
        let start = Instant::now();
        cx.update_window(handle, |_, window, cx| window.render_frame(cx))
            .unwrap();
        warm.push(millis(start));
    }
    let mut updates = Vec::new();
    for _ in 0..4 {
        eprintln!("scaling phase: append drain");
        source.push_str(&"x".repeat(100));
        let start = Instant::now();
        view.update(&mut cx, |view, cx| {
            view.text
                .update(cx, |state, cx| state.set_text(&source, cx))
        });
        cx.run_until_parked();
        assert!(cx.update(|cx| view.read(cx).text.read(cx).rendered_text().source() == source));
        let ready_ms = millis(start);
        let frame = Instant::now();
        cx.update_window(handle, |_, window, cx| window.render_frame(cx))
            .unwrap();
        updates.push(json!({"ready_ms":ready_ms,"frame_cpu_ms":millis(frame)}));
    }
    assert_eq!(source.len(), bytes);
    eprintln!("scaling phase: capture");
    let shot = cx
        .capture_screenshot(handle)
        .expect("real native GPU renderer required");
    assert!(shot.width() >= 960 && shot.height() >= 760);
    view.update(&mut cx, |view, cx| {
        view.source_copy = true;
        cx.notify();
    });
    eprintln!("scaling phase: source format frame");
    cx.update_window(handle, |_, window, cx| window.render_frame(cx))
        .unwrap();
    view.update(&mut cx, |view, cx| {
        view.text.update(cx, |state, cx| state.select_all(cx))
    });
    eprintln!("scaling phase: selected source frame");
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(
            TextSelection::selected_text(window, cx),
            source,
            "full source selection/copy after settled appends"
        );
    })
    .unwrap();
    println!(
        "{}",
        json!({"case":kind,"initial_bytes":bytes-400,"final_bytes":bytes,"initial_source_sha256":source_hash,"construction_ms":construction_ms,"ready_wall_ms":ready_wall_ms,"first_frame_cpu_ms":first_frame_cpu_ms,"warm_frames_cpu_ms":warm,"settled_100_byte_updates":updates,"source_ready_and_full_copy_asserted":true,"offscreen_only":true})
    );
}
