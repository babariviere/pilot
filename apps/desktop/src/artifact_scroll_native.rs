//! Hidden native window, production dispatchers. Draw timings are not presentation timings.
use super::*;

pub fn run(cx: &mut App) {
    let dir = std::path::PathBuf::from(
        std::env::var_os("PILOT_NEXT_ARTIFACT_SCROLL_DIR").expect("private output directory"),
    );
    std::fs::create_dir_all(&dir).unwrap();
    let server = Server::new();
    let mut rows = fixture_rows(&server);
    let (h, view) = gpui_kit::open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                Default::default(),
                size(px(1100.), px(1000.)),
            ))),
            show: false,
            focus: false,
            ..Default::default()
        },
        cx,
        |w, cx| {
            cx.new(|cx| {
                crate::LocalViewer::inline_visual_fixture(
                    server.options.clone(),
                    rows.clone(),
                    w,
                    cx,
                )
            })
        },
    )
    .unwrap();
    let t = view.read(cx).inline_probe_transcript();
    view.update(cx, |v, cx| {
        v.inline_probe_enable(server.options.clone(), cx)
    });
    t.update(cx, |v, cx| v.inline_probe_scroll(0, cx));
    h.update(cx, |_, w, cx| w.draw(cx).clear(cx)).unwrap();
    let executor = cx.background_executor().clone();
    cx.spawn(async move |cx| {
        ACTIVE.with(|a| a.set(true));
        let mut records = Vec::new();
        for phase in ["cold","resident","warm","streaming"] {
            let reads_before = server.reads.lock().unwrap().len();
            let mut frames = Vec::new();
            for step in 0..160 {
                executor.timer(Duration::from_millis(16)).await;
                let start = Instant::now();
                if phase == "streaming" && step % 4 == 0 {
                    *rows.last_mut().unwrap() = Message::live(999,"Assistant".into(),format!("Streaming tail {}","word ".repeat(step+1)));
                    t.update(cx,|t,cx| t.replace_readonly(rows.clone(),false,cx));
                }
                let (draw_ms, anchor, panes) = cx.update_window(h,|_,w,cx| {
                    let bounds = w.find("viewport").bounds();
                    let position = bounds.origin + point(px(4.),px(180.));
                    let delta = if phase == "resident" {if step%2 == 0 {-2.} else {2.}} else if step < 80 {-42.} else {42.};
                    w.dispatch_event(ScrollEvent {position,delta:ScrollDelta::Pixels(point(px(0.),px(delta))),..Default::default()}.to_platform_input(),cx);
                    let drawing = Instant::now();
                    w.draw(cx).clear(cx);
                    let draw_ms = drawing.elapsed().as_secs_f64()*1000.;
                    let panes = t.read(cx).inline_probe_panes();
                    for (_,pane) in &panes {
                        assert!(pane.read(cx).inline_probe_snapshot().error.is_none(), "fixture must render artifacts, not error placeholders");
                    }
                    (draw_ms,t.read(cx).history_probe_anchor(cx),panes.len())
                }).unwrap();
                frames.push(json!({"step":step,"ms":start.elapsed().as_secs_f64()*1000.,"draw_ms":draw_ms,"anchor":[anchor.0,anchor.1],"panes":panes}));
                if (30..38).contains(&step) || (108..116).contains(&step) {
                    let shot = cx.update_window(h, |_,w,_| w.render_to_image()).unwrap().unwrap();
                    let file = std::fs::File::create(dir.join(format!("native-{phase}-{step:03}.png"))).unwrap();
                    image::ImageEncoder::write_image(image::codecs::png::PngEncoder::new_with_quality(file,image::codecs::png::CompressionType::Fast,image::codecs::png::FilterType::NoFilter),shot.as_raw(),shot.width(),shot.height(),image::ExtendedColorType::Rgba8).unwrap();
                }
            }
            let work = WORK.with(|w| std::mem::take(&mut *w.borrow_mut()));
            records.push(json!({"phase":phase,"frames":frames,"work":work,"reads":server.reads.lock().unwrap().len()-reads_before}));
        }
        ACTIVE.with(|a| a.set(false));
        std::fs::write(dir.join("native-timings.json"),serde_json::to_vec_pretty(&records).unwrap()).unwrap();
        println!("hidden native scroll journey: {} (draw, not presentation)",dir.display());
        cx.update_window(h,|_,w,_| w.remove_window()).unwrap();
        drop(server);
        cx.update(|cx| cx.quit());
    }).detach();
}
