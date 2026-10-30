//! Actual admitted Return, synthetic writes only, hidden native drawing.
use super::*;
use gpui_kit::ElementId;
use std::time::Instant;

fn frame(cx: &mut HeadlessAppContext, h: AnyWindowHandle, ms: u64) -> (f64, f64) {
    cx.advance_clock(Duration::from_millis(ms));
    cx.update_window(h, |_, w, cx| w.simulate_next_frame(cx))
        .unwrap();
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| {
        let start = Instant::now();
        w.draw(cx).clear(cx);
        let draw = start.elapsed().as_secs_f64() * 1000.;
        let start = Instant::now();
        w.render_to_image()
            .expect("native offscreen renderer and RGBA readback");
        (draw, start.elapsed().as_secs_f64() * 1000.)
    })
    .unwrap()
}

fn height(cx: &mut HeadlessAppContext, h: AnyWindowHandle, id: impl Into<ElementId>) -> f32 {
    let id = id.into();
    cx.update_window(h, |_, w, _| f32::from(w.find(id).bounds().size.height))
        .unwrap()
}

fn key(p: &Probe, cx: &mut HeadlessAppContext) -> u64 {
    cx.update(|cx| p.v.read(cx).transcript.read(cx).rows().last().unwrap().id())
}

fn assert_follow(p: &Probe, cx: &mut HeadlessAppContext) {
    cx.update_window(p.h, |_, w, cx| {
        let t = p.v.read(cx).transcript.read(cx);
        assert!(
            t.history_probe_anchor(cx).2,
            "bottom follow survives arrival"
        );
        let id = t.rows().last().unwrap().id();
        let slot = w.find(("message-arrival", id)).bounds();
        let viewport = w.find("viewport").bounds();
        assert!(
            slot.bottom() <= viewport.bottom() + px(1.),
            "arriving slot must stay inside transcript bottom"
        );
    })
    .unwrap();
}

fn clear_input(p: &Probe, cx: &mut HeadlessAppContext) {
    cx.update_window(p.h, |_, w, cx| {
        let input = p.v.read(cx).editor.read(cx).shell_probe().0;
        input.update(cx, |i, cx| {
            i.unmark_text(w, cx);
            i.set_value("", w, cx);
            i.focus(w, cx);
        });
    })
    .unwrap();
    cx.run_until_parked();
}

fn accept(p: &mut Probe, cx: &mut HeadlessAppContext, draft: &Draft, request: u64, entry: u64) {
    let intent = p
        .store
        .prepare("chat:synthetic", draft, false, false)
        .unwrap()
        .id;
    p.store.finish(&intent, "accepted", None).unwrap();
    p.write(cx, Some(request));
    p.publish(
        cx,
        json!({"type":"message_end","entry":user(entry, &draft.text)}),
    );
}

pub(super) fn run(cx: &mut HeadlessAppContext, p: &mut Probe, width: f32, mode: &str) {
    let h = p.h;
    cx.update(|cx| cx.set_reduce_motion(false));
    let source = "Arrival 日本語 e\u{301} 👩‍💻\nA second line, unchanged during arrival.";
    let (draft, request) = p.send_now(cx, source);
    let id = key(p, cx);
    frame(cx, h, 0);
    let start = height(cx, h, ("message-arrival", id));
    assert_follow(p, cx);
    let mut costs = Vec::new();
    let (draw, render) = frame(cx, h, 64);
    let middle = height(cx, h, ("message-arrival", id));
    assert_follow(p, cx);
    costs.push(json!({"draw_ms":draw,"renderer_readback_ms":render}));
    let transcript = cx.update(|cx| p.v.read(cx).transcript.clone());
    let text = cx.update(|cx| transcript.read(cx).history_probe_row(id));
    let text_width = cx.update(|cx| f32::from(text.read(cx).bounds().size.width));
    let middle_top = cx.update(|cx| f32::from(text.read(cx).bounds().top()));
    capture(cx, h, format!("{}-{mode}-arrival-64ms.png", width as u32));
    // Selection is owned by the same parser across unrelated publications.
    cx.update_window(h, |_, w, cx| {
        let b = text.read(cx).bounds();
        let from = point(b.left() + px(3.), b.top() + px(9.));
        w.drag(from, from + point(px(110.), px(0.)), cx);
        assert!(!text.read(cx).selected_text().is_empty());
    })
    .unwrap();
    let selected = cx.update(|cx| text.read(cx).selected_text());
    p.publish_now(cx, json!({"type":"jobs_update","jobs":[]}));
    frame(cx, h, 0);
    assert_eq!(
        height(cx, h, ("message-arrival", id)),
        middle,
        "republication must not restart arrival"
    );
    // Next input's preedit stays intact while the previous message arrives.
    let input = cx.update(|cx| p.v.read(cx).editor.read(cx).shell_probe().0);
    cx.update_window(h, |_, w, cx| {
        input.update(cx, |i, cx| {
            i.focus(w, cx);
            i.replace_and_mark_text_in_range(None, "日本", Some(1..2), w, cx);
        })
    })
    .unwrap();
    let (draw, render) = frame(cx, h, 64);
    costs.push(json!({"draw_ms":draw,"renderer_readback_ms":render}));
    let later = height(cx, h, ("message-arrival", id));
    assert_follow(p, cx);
    let later_top = cx.update(|cx| f32::from(text.read(cx).bounds().top()));
    let (draw, render) = frame(cx, h, 120);
    costs.push(json!({"draw_ms":draw,"renderer_readback_ms":render}));
    let end = height(cx, h, ("message-arrival", id));
    assert_follow(p, cx);
    let end_top = cx.update(|cx| f32::from(text.read(cx).bounds().top()));
    assert!(
        end_top < later_top && later_top < middle_top,
        "the full-size message rises from the composer, {middle_top}/{later_top}/{end_top}"
    );
    assert!(
        start < middle && middle < later && later < end,
        "arrival {start}/{middle}/{later}/{end}"
    );
    assert_eq!(
        text_width,
        cx.update(|cx| f32::from(text.read(cx).bounds().size.width)),
        "clip, never reflow the full child"
    );
    cx.update_window(h, |_, w, cx| {
        assert_eq!(text.read(cx).selected_text(), selected);
        assert_eq!(input.read(cx).value().as_str(), "日本");
        assert_eq!(
            input.update(cx, |i, cx| i.marked_text_range(w, cx)),
            Some(0..2)
        );
        assert!(input.focus_handle(cx).is_focused(w));
        assert!(
            transcript.read(cx).history_probe_anchor(cx).2,
            "bottom follow survives every arrival frame"
        );
        crate::transcript_view::click_copy(w, id, cx);
        assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), source);
    })
    .unwrap();
    clear_input(p, cx);
    let idle_cost = frame(cx, h, 1000);
    accept(p, cx, &draft, request, 80);
    // The canonical history echo is not a second arrival, even with exact text.
    cx.update_window(h, |_, w, cx| {
        assert!(w.find_all(("message-arrival", id)).is_empty());
        for row in p.v.read(cx).transcript.read(cx).rows() {
            assert!(w.find_all(("message-arrival", row.id())).is_empty());
        }
    })
    .unwrap();

    // Response growth and reconnect/snapshot mount never create arrival slots.
    p.publish_now(
        cx,
        json!({"type":"message_start","message":{"role":"assistant","content":[]}}),
    );
    p.publish_now(cx, json!({"type":"message_update","changes":[{"type":"text_start","contentIndex":0,"block":{"type":"text","text":"Streaming"}}]}));
    for _ in 0..3 {
        p.publish_now(cx, json!({"type":"message_update","changes":[{"type":"text_delta","contentIndex":0,"delta":" more\n"}]}));
        frame(cx, h, 64);
        cx.update_window(h, |_, w, cx| {
            for row in p.v.read(cx).transcript.read(cx).rows() {
                assert!(w.find_all(("message-arrival", row.id())).is_empty());
            }
        })
        .unwrap();
    }
    p.publish(cx, json!({"type":"message_end","entry":reply(81)}));
    let snapshot = json!({"type":"snapshot","entries":[user(80, source),reply(81)]});
    p.publish(cx, snapshot);
    cx.update_window(h, |_, w, cx| {
        for row in p.v.read(cx).transcript.read(cx).rows() {
            assert!(w.find_all(("message-arrival", row.id())).is_empty());
        }
    })
    .unwrap();

    // A resize snaps to natural height, including when the message rewraps.
    let (draft, request) = p.send_now(cx, &"A newly sent long line 日本語. ".repeat(14));
    let resized_id = key(p, cx);
    frame(cx, h, 0);
    frame(cx, h, 64);
    cx.update_window(h, |_, w, cx| {
        w.resize(size(px(width + 100.), px(760.)));
        w.bounds_changed(cx);
    })
    .unwrap();
    frame(cx, h, 0);
    let resized = height(cx, h, ("message-arrival", resized_id));
    cx.update(|cx| cx.set_reduce_motion(true));
    frame(cx, h, 0);
    assert_eq!(height(cx, h, ("message-arrival", resized_id)), resized);
    accept(p, cx, &draft, request, 82);
    cx.update_window(h, |_, w, cx| {
        w.resize(size(px(width), px(760.)));
        w.bounds_changed(cx);
    })
    .unwrap();
    frame(cx, h, 0);

    // A replaced history scope cannot carry arrival motion into a fresh mount.
    cx.update(|cx| cx.set_reduce_motion(false));
    let (draft, request) = p.send_now(cx, "Reset while arriving");
    let reset_id = key(p, cx);
    frame(cx, h, 0);
    frame(cx, h, 64);
    cx.update(|cx| {
        transcript.update(cx, |t, cx| {
            let rows = t.rows().to_vec();
            t.replace_readonly(rows, true, cx);
        })
    });
    frame(cx, h, 0);
    cx.update_window(h, |_, w, _| {
        assert!(w.find_all(("message-arrival", reset_id)).is_empty())
    })
    .unwrap();
    accept(p, cx, &draft, request, 84);
    cx.update(|cx| cx.set_reduce_motion(true));

    // Reduced motion starts at natural geometry, with no scheduled work.
    let (draft, request) = p.send_now(cx, "Reduced-motion message");
    let reduced_id = key(p, cx);
    frame(cx, h, 0);
    let reduced = height(cx, h, ("message-arrival", reduced_id));
    frame(cx, h, 64);
    assert_eq!(height(cx, h, ("message-arrival", reduced_id)), reduced);
    assert!(reduced > 0.);
    accept(p, cx, &draft, request, 83);
    cx.update(|cx| cx.set_reduce_motion(false));

    // A refusal/removal during arrival removes content and hit targets at once.
    let (_, request) = p.send_now(cx, "Refused during arrival");
    let removed = key(p, cx);
    frame(cx, h, 0);
    frame(cx, h, 64);
    p.write_now(cx, Some(request));
    frame(cx, h, 0);
    cx.update_window(h, |_, w, _| {
        assert!(w.find_all(("message-arrival", removed)).is_empty());
        assert!(w.find_all(("copy-source", removed)).is_empty());
    })
    .unwrap();
    clear_input(p, cx);
    // Sending while reading history never steals the canonical reading anchor.
    p.publish(
        cx,
        json!({"type":"snapshot","entries":(100..140).map(reply).collect::<Vec<_>>()}),
    );
    cx.update_window(h, |_, w, cx| {
        w.scroll("viewport", ScrollDelta::Lines(point(0., 100.)), cx);
    })
    .unwrap();
    frame(cx, h, 240);
    let reading = cx.update(|cx| p.v.read(cx).transcript.read(cx).reading_mark(cx).unwrap());
    assert!(!reading.following);
    let (_, request) = p.send_now(cx, "Send without stealing the reader");
    for ms in [0, 64, 240] {
        frame(cx, h, ms);
        let after = cx.update(|cx| p.v.read(cx).transcript.read(cx).reading_mark(cx).unwrap());
        assert_eq!(after.message, reading.message);
        assert!(!after.following);
        assert!((after.offset - reading.offset).abs() <= 1.);
    }
    p.write(cx, Some(request));
    clear_input(p, cx);
    frame(cx, h, 1000);
    for _ in 0..3 {
        assert_eq!(
            cx.update_window(h, |_, w, cx| w.simulate_next_frame(cx))
                .unwrap(),
            0,
            "idle arrival schedules no callbacks"
        );
    }
    println!(
        "{}",
        json!({"motion":"sent-arrival","width":width,"mode":mode,"height":[start,middle,later,end],"top":[middle_top,later_top,end_top],"costs":costs,"settled_cost_ms":{"draw":idle_cost.0,"renderer_readback":idle_cost.1},"idle_callbacks":0})
    );
    // Arrival does not reverse: removal is immediate. Existing disclosure tests
    // cover the shared slot's reversible path without resurrecting hidden text.
    cx.update(|cx| cx.set_reduce_motion(true));
}
