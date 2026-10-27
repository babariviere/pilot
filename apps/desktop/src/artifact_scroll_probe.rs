//! Opt-in offscreen scroll journey. Times synchronous native work, not presentation.
use super::*;
use gpui_kit::{InputEvent, ScrollWheelEvent};
use std::{cell::RefCell, collections::BTreeMap};

thread_local! {
    static WORK: RefCell<BTreeMap<&'static str, (usize, f64)>> = const { RefCell::new(BTreeMap::new()) };
    static ACTIVE: Cell<bool> = const { Cell::new(false) };
}
pub(crate) struct Work(&'static str, Instant);
pub(crate) fn work(name: &'static str) -> Option<Work> {
    ACTIVE.with(|active| active.get().then(|| Work(name, Instant::now())))
}
impl Drop for Work {
    fn drop(&mut self) {
        WORK.with(|work| {
            let mut work = work.borrow_mut();
            let item = work.entry(self.0).or_default();
            item.0 += 1;
            item.1 += self.1.elapsed().as_secs_f64() * 1000.;
        });
    }
}

pub(super) const SOURCE: &str = r#"({ui,state})=>{
const s=state({on:false});
const x=Array.from({length:600},(_,i)=>String(i));
return()=>ui.column({gap:8},[
 ui.toggle({label:'Forecast',value:s.on,onChange:v=>s.on=v}),
 ui.chart({type:'line',height:180,x,series:[{name:'Observed',values:x.map((_,i)=>30+20*Math.sin(i/9))}]}),
 ui.mermaid('flowchart LR; A[Prepare]-->B[Measure]; B-->C[Paint]; A-->C'),
 ui.canvas({height:80,label:'Drawing',draw:(g,f)=>g.rect(8,8,f.width-16,45,{fill:'chart1'})}),
 ui.table({columns:Array.from({length:8},(_,i)=>'Column '+i),rows:Array.from({length:40},(_,r)=>Array.from({length:8},(_,c)=>r*8+c))})
]);}"#;

#[path = "artifact_scroll_native.rs"]
pub(crate) mod native;

fn fixture_rows(server: &Server) -> Vec<Message> {
    let mut rows = Vec::new();
    for group in 0..6 {
        let id = 100 + group * 10;
        rows.push(Message::live(id, "Assistant".into(), format!("Study {group}. Mixed native charts, diagrams, images and readable text.\n\nScroll through this conversation without losing its reading position.")));
        let mut r = reference(&format!("scroll-{group}"), 1);
        r.kind = "visual".into();
        rows.push(Message::artifact(id + 1, r));
        let mut r = reference("raster-large", 1);
        // Distinct exact identities, same synthetic bytes.
        r.id = format!("raster-large-{group}");
        r.kind = "image".into();
        rows.push(Message::artifact(id + 2, r));
        let mut source = crate::conversation_images::Source::read(
            0,
            &json!({"mimeType":"image/png","data":server.scroll_raster.split_once(',').unwrap().1}),
        );
        source.owner = Some((server.options.host(), "owner".into()));
        rows.push(
            Message::image(id + 3, "Stored image".into(), source)
                .anchored(crate::model::ReaderKey::model(id, 0, Some(0))),
        );
    }
    rows.push(Message::live(
        999,
        "Assistant".into(),
        "Streaming tail".into(),
    ));
    rows
}

pub(super) fn run(cx: &mut HeadlessAppContext) {
    let dir = std::path::PathBuf::from(std::env::var_os("PILOT_NEXT_ARTIFACT_SCROLL_DIR").unwrap());
    std::fs::create_dir_all(&dir).unwrap();
    let server = Server::new();
    let mut rows = fixture_rows(&server);
    let (h, view) = cx.update(|cx| {
        gpui_kit::open_window(
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
        .unwrap()
    });
    let t = cx.update(|cx| view.read(cx).inline_probe_transcript());
    cx.update(|cx| {
        view.update(cx, |v, cx| {
            v.inline_probe_enable(server.options.clone(), cx)
        });
        t.update(cx, |t, cx| t.inline_probe_scroll(0, cx));
    });
    frame(cx, h);
    ACTIVE.with(|a| a.set(true));
    let mut records = Vec::new();
    // Cold traversal, warmed traversal, and repeated streaming invalidation.
    for phase in ["cold", "resident", "warm", "streaming"] {
        let reads_before = server.reads.lock().unwrap().len();
        let renders_before = cx.update(|cx| t.read(cx).probe_render_count());
        let mut frames = Vec::new();
        for step in 0..160 {
            let start = Instant::now();
            if phase == "streaming" && step % 4 == 0 {
                let last = rows.last_mut().unwrap();
                *last = Message::live(
                    999,
                    "Assistant".into(),
                    format!("Streaming tail {}", "word ".repeat(step + 1)),
                );
                cx.update(|cx| t.update(cx, |t, cx| t.replace_readonly(rows.clone(), false, cx)));
            }
            cx.update_window(h, |_, w, cx| {
                let bounds = w.find("viewport").bounds();
                let position = bounds.origin + point(px(4.), px(180.));
                w.dispatch_event(
                    ScrollWheelEvent {
                        position,
                        delta: ScrollDelta::Pixels(point(
                            px(0.),
                            px(if phase == "resident" {
                                if step % 2 == 0 { -2. } else { 2. }
                            } else if step < 80 {
                                -42.
                            } else {
                                42.
                            }),
                        )),
                        ..Default::default()
                    }
                    .to_platform_input(),
                    cx,
                );
            })
            .unwrap();
            let dispatched = start.elapsed().as_secs_f64() * 1000.;
            let draw_start = Instant::now();
            cx.advance_clock(Duration::from_millis(16));
            cx.run_until_parked();
            let park_ms = draw_start.elapsed().as_secs_f64() * 1000.;
            let drawing = Instant::now();
            cx.update_window(h, |_, w, cx| w.draw(cx).clear(cx))
                .unwrap();
            let draw_ms = drawing.elapsed().as_secs_f64() * 1000.;
            let ms = start.elapsed().as_secs_f64() * 1000.;
            let (anchor, panes) = cx.update(|cx| {
                (
                    t.read(cx).history_probe_anchor(cx),
                    t.read(cx).inline_probe_panes().len(),
                )
            });
            frames.push(json!({"step":step,"ms":ms,"dispatch_ms":dispatched,"park_ms":park_ms,"draw_ms":draw_ms,"anchor":[anchor.0,anchor.1],"panes":panes}));
            // Consecutive raw captures, outside the measured interval. No contact-sheet-only evidence.
            if (30..38).contains(&step) || (108..116).contains(&step) {
                let shot = cx.capture_screenshot(h).unwrap();
                let file =
                    std::fs::File::create(dir.join(format!("{phase}-{step:03}.png"))).unwrap();
                image::ImageEncoder::write_image(
                    image::codecs::png::PngEncoder::new_with_quality(
                        file,
                        image::codecs::png::CompressionType::Fast,
                        image::codecs::png::FilterType::NoFilter,
                    ),
                    shot.as_raw(),
                    shot.width(),
                    shot.height(),
                    image::ExtendedColorType::Rgba8,
                )
                .unwrap();
            }
            // Let real confined readers/decoders run, without attributing wait to CPU work.
            std::thread::sleep(Duration::from_millis(8));
        }
        let work = WORK.with(|w| std::mem::take(&mut *w.borrow_mut()));
        records.push(json!({"phase":phase,"frames":frames,"work":work,"reads":server.reads.lock().unwrap().len()-reads_before,"transcript_renders":cx.update(|cx| t.read(cx).probe_render_count())-renders_before}));
    }
    ACTIVE.with(|a| a.set(false));
    std::fs::write(
        dir.join("timings.json"),
        serde_json::to_vec_pretty(&records).unwrap(),
    )
    .unwrap();
    println!("artifact scroll CPU/layout journey: {}", dir.display());
    cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    cx.run_until_parked();
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::{
        Render, TestAppContext, TestSupportExt,
        base::{SelectableText, TextSelection, TextSelectionHandle},
    };

    struct SelectionView {
        selected: TextSelectionHandle,
        text: String,
    }
    impl Render for SelectionView {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div()
                .v_flex()
                .size_full()
                .child(div().id("selection-cell").test_support().w_full().child(
                    SelectableText::with_handle(
                        "selected",
                        self.selected.clone(),
                        self.text.clone(),
                    ),
                ))
                .children(
                    (0usize..320).map(|i| SelectableText::new(("cell", i), format!("Cell {i}"))),
                )
        }
    }
    #[gpui_kit::test]
    fn dense_table_preserves_wrapping_columns_scroll_and_copy(cx: &mut TestAppContext) {
        cx.update(gpui_kit::init);
        for width in [680., 1100.] {
            let columns = (0..8)
                .map(|i| json!({"label":format!("Column {i}")}))
                .collect::<Vec<_>>();
            let mut rows = (0..40)
                .map(|r| (0..8).map(|c| json!(r * 8 + c)).collect::<Vec<_>>())
                .collect::<Vec<_>>();
            rows[0][0] = json!("Long 日本語 résumé text ".repeat(8));
            let scene = crate::visual_scene::Scene::parse(
                json!({"api":1,"root":{"type":"table","columns":columns,"rows":rows}}),
            )
            .unwrap();
            let h = cx.update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(800.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |_, cx| {
                        cx.new(|cx| {
                            let mut pane = ArtifactPane::new();
                            pane.preview(
                                reference("table", 1),
                                "Exact synthetic table source".into(),
                                scene,
                                cx,
                            );
                            pane.inline_mode(true, cx);
                            pane
                        })
                    },
                )
                .unwrap()
                .0
            });
            cx.update_window(h, |_, w, cx| {
                w.render_frame(cx);
                let first = w.find("0-0-0").bounds();
                let next = w.find("0-1-0").bounds();
                assert!(
                    first.size.height > w.find("0-1-0").bounds().size.height,
                    "long cells wrap"
                );
                assert!(next.top() >= first.bottom(), "rows never overlap");
                for col in 0..8 {
                    let a = w.find(format!("0-0-{col}")).bounds();
                    let b = w.find(format!("0-1-{col}")).bounds();
                    assert!(
                        (a.left() - b.left()).abs() < px(1.),
                        "columns align across wrapped rows"
                    );
                    assert!(
                        (a.size.width - first.size.width).abs() < px(1.),
                        "equal-width columns retained"
                    );
                }
                w.scroll(
                    "inline-visual-content",
                    ScrollDelta::Pixels(point(px(0.), px(-10000.))),
                    cx,
                );
                let last = w.find("0-39-7").bounds();
                let viewport = w.find("inline-visual-content").bounds();
                assert!(
                    last.bottom() <= viewport.bottom(),
                    "last row remains reachable"
                );
                w.drag(
                    point(last.left() + px(1.), last.center().y),
                    point(last.right() - px(1.), last.center().y),
                    cx,
                );
                assert_eq!(TextSelection::selected_text(w, cx), "319");
                w.remove_window();
            })
            .unwrap();
        }
    }
    #[gpui_kit::test]
    fn painting_cells_never_invokes_window_copy_callbacks_and_keeps_projection_current(
        cx: &mut TestAppContext,
    ) {
        cx.update(gpui_kit::init);
        let copies = Rc::new(Cell::new(0));
        let (h, view) = cx.update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    show: false,
                    focus: false,
                    ..Default::default()
                },
                cx,
                |_, cx| {
                    cx.new(|cx| {
                        let selected = TextSelectionHandle::new("before", cx);
                        selected.set_local_selection(true, cx);
                        let copies = copies.clone();
                        selected.copy_with(
                            move |_| {
                                copies.set(copies.get() + 1);
                                "explicit copy".into()
                            },
                            cx,
                        );
                        SelectionView {
                            selected,
                            text: "before".into(),
                        }
                    })
                },
            )
            .unwrap()
        });
        cx.update_window(h, |_, w, cx| {
            w.draw(cx).clear(cx);
            assert_eq!(
                copies.get(),
                0,
                "painting must not serialize window selection"
            );
            assert_eq!(TextSelection::selected_text(w, cx), "explicit copy");
            assert_eq!(copies.get(), 1, "explicit copy still invokes the callback");
        })
        .unwrap();
        for text in ["after 👩🏽‍💻", "changed 日本語"] {
            view.update(cx, |v, cx| {
                v.text = text.into();
                cx.notify();
            });
            cx.update_window(h, |_, w, cx| {
                w.draw(cx).clear(cx);
                assert_eq!(
                    copies.get(),
                    1,
                    "repainting must not invoke any copy callback"
                );
            })
            .unwrap();
        }
        view.update(cx, |v, cx| {
            v.selected.set_local_selection(false, cx);
            v.selected = TextSelectionHandle::new("stale fallback", cx);
        });
        cx.update_window(h, |_, w, cx| {
            w.render_frame(cx);
            let bounds = w.find("selection-cell").bounds();
            w.drag(
                point(bounds.left() + px(1.), bounds.center().y),
                point(bounds.right() - px(1.), bounds.center().y),
                cx,
            );
            assert_eq!(TextSelection::selected_text(w, cx), "changed 日本語");
        })
        .unwrap();
        for text in ["current 👩🏽‍💻", "new 日本語"] {
            view.update(cx, |v, cx| {
                v.text = text.into();
                cx.notify();
            });
            cx.update_window(h, |_, w, cx| {
                w.draw(cx).clear(cx);
                assert_eq!(TextSelection::selected_text(w, cx), text);
            })
            .unwrap();
        }
        cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
    }
}
