//! Real production conversation, owned faux GET server and confined helper.
use super::*;
use base64::Engine;
use gpui_kit::{
    AnyWindowHandle, Bounds, HeadlessAppContext, ScrollDelta, WindowBounds, WindowOptions, point,
    size, test::TestWindowExt,
};
use serde_json::json;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[path = "artifact_scroll_probe.rs"]
pub(crate) mod scroll;

const SOURCE: &str = r#"({ui,state})=>{
const s=state({on:false,n:4,tab:'Week',clicks:0});
return()=>ui.column({gap:8},[
 ui.text('Study · 日本語 résumé 🌍 · '+s.n+' units · '+s.clicks+' changes'),
 ui.row({gap:12},[
  ui.toggle({label:'Include forecast',value:s.on,onChange:v=>s.on=v}),
  ui.tabs({options:['Week','Month'],value:s.tab,onChange:v=>s.tab=v}),
  ui.button({label:'Compare',onClick:()=>s.clicks++})
 ]),
 ui.chart({type:'bar',height:160,x:['North','South','West'],series:[{name:'Observed',values:[s.n,7,5]},{name:'Forecast',values:[6,s.on?9:0,8]}]}),
 ui.slider({label:'Units',min:0,max:10,step:1,value:s.n,onChange:v=>s.n=v}),
 ui.table({columns:['Region','Units'],rows:[['North',s.n],['東京',7]]}),
 ui.canvas({height:80,label:'Study drawing',draw:(g,f)=>{g.rect(8,8,f.width-16,45,{fill:'chart1'});g.text(16,70,'Native canvas',{color:'text'});}})
]);
}"#;
pub(crate) struct Server {
    raster: Arc<String>,
    scroll_raster: Arc<String>,
    pub(crate) options: crate::LocalOptions,
    pub(crate) reads: Arc<Mutex<Vec<(String, u32)>>>,
    stop: Option<async_channel::Sender<()>>,
    done: std::sync::mpsc::Receiver<()>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    pub(crate) fn new() -> Self {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let options = crate::LocalOptions::synthetic(listener.local_addr().unwrap().port());
        let mut pixels = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            32,
            16,
            image::Rgb([24, 110, 220]),
        ))
        .write_to(&mut pixels, image::ImageFormat::Png)
        .unwrap();
        let raster = Arc::new(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(pixels.into_inner())
        ));
        let mut large = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(1024, 640, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 180])
        }))
        .write_to(&mut large, image::ImageFormat::Png)
        .unwrap();
        let large = Arc::new(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(large.into_inner())
        ));
        let scroll_raster = large.clone();
        let served_raster = raster.clone();
        let mut gif_bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            32,
            16,
            image::Rgb([24, 110, 220]),
        ))
        .write_to(&mut gif_bytes, image::ImageFormat::Gif)
        .unwrap();
        let served_gif = Arc::new(format!(
            "data:image/gif;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(gif_bytes.into_inner())
        ));

        let reads = Arc::new(Mutex::new(Vec::new()));
        let records = reads.clone();
        let (stop, closed) = async_channel::bounded(1);
        let (done, finished) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async move {
                let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                let mut handlers = tokio::task::JoinSet::new();
                loop { tokio::select! { biased; _=closed.recv()=>break, connection=listener.accept()=>{
                    let Ok((stream,_))=connection else {break;};
                    let records=records.clone();let raster=served_raster.clone();let gif=served_gif.clone();let large=large.clone();
                    handlers.spawn(async move {
                        let op=async {
                            let mut stream=BufReader::new(stream); let mut headers=String::new();
                            loop { let mut line=String::new(); if stream.read_line(&mut line).await?==0 {return Ok::<(),std::io::Error>(());} headers.push_str(&line);if headers.len()>8192{return Ok(());}
if line=="\r\n"{break;} }
                            assert!(!headers.to_lowercase().contains("authorization:")&&!headers.to_lowercase().contains("cookie:"));
                            let request=headers.lines().next().unwrap();assert!(request.starts_with("GET "));
                            let path=request.split_whitespace().nth(1).unwrap();
                            let body=if path=="/api/hello" {json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}})} else {
                                let tail=path.strip_prefix("/api/sessions/owner/artifacts/").expect("only exact current-chat reads");
                                let(id,r)=tail.split_once("?revision=").unwrap();let r=r.parse::<u32>().unwrap();assert!((1..=2).contains(&r));
                                records.lock().unwrap().push((id.into(),r));
                                let(kind,source)=match id {id if id.starts_with("scroll-") => ("visual",scroll::SOURCE), id if id.starts_with("raster-large-") => ("image",large.as_str()),"raster" | "raster-a" | "raster-b" | "raster-c"=>("image",raster.as_str()),"raster-gif"=>("image",gif.as_str()),"legacy"=>("html","<script>inert stored source</script>"),"broken"=>("visual","()=>{throw new Error('Synthetic local failure') }"),_=>("visual",SOURCE)};
                                json!({"id":id,"sessionId":"owner","revision":r,"title":"Regional study · 日本語 résumé","kind":kind,"source":source,"data":null,"createdAt":1,"updatedAt":2,"visual":{"api":1,"engine":"quickjs-ng 0.17.0"}})
                            }.to_string();
                            let mut stream=stream.into_inner();stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).as_bytes()).await?;stream.write_all(body.as_bytes()).await?;Ok(())
                        }; let _=tokio::time::timeout(Duration::from_secs(2),op).await;
                    });
                },_=handlers.join_next(),if !handlers.is_empty()=>{} } }
                handlers.abort_all();while handlers.join_next().await.is_some(){}
            });
            let _ = done.send(());
        });
        Self {
            raster,
            scroll_raster,
            options,
            reads,
            stop: Some(stop),
            done: finished,
            thread: Some(thread),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop = None;
        self.done
            .recv_timeout(Duration::from_secs(4))
            .expect("bounded faux teardown");
        self.thread.take().unwrap().join().unwrap();
    }
}
pub(crate) fn reference(id: &str, revision: u32) -> Reference {
    Reference {
        id: id.into(),
        session: "owner".into(),
        title: "Regional study · 日本語 résumé".into(),
        kind: "unknown".into(),
        revision,
    }
}
fn rows() -> Vec<Message> {
    vec![
        Message::live(
            1,
            "Assistant".into(),
            "Compare the regions, then adjust the local study below.".into(),
        )
        .anchored(crate::model::ReaderKey::model(1, 0, Some(0))),
        Message::artifact(2, reference("study", 1)),
    ]
}
fn frame(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    cx.advance_clock(Duration::from_millis(16));
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
}
#[track_caller]
fn wait(cx: &mut HeadlessAppContext, h: AnyWindowHandle, test: impl Fn(&gpui_kit::App) -> bool) {
    let end = Instant::now() + Duration::from_secs(12);
    loop {
        frame(cx, h);
        if cx.update(|cx| test(cx)) {
            break;
        }
        assert!(
            Instant::now() < end,
            "bounded inline settle at {}",
            std::panic::Location::caller()
        );
        std::thread::yield_now();
    }
    frame(cx, h);
}
fn pane(t: &Entity<TranscriptView>, cx: &App) -> Option<Entity<ArtifactPane>> {
    t.read(cx)
        .inline_probe_panes()
        .first()
        .map(|(_, p)| p.clone())
}
fn ready(t: &Entity<TranscriptView>, cx: &App) -> bool {
    pane(t, cx).is_some_and(|p| {
        assert!(
            p.read(cx).inline_probe_snapshot().error.is_none(),
            "native preview failure: {:?}",
            p.read(cx).inline_probe_snapshot().error
        );
        p.read(cx)
            .inline_probe_snapshot()
            .scene
            .is_some_and(|_| p.read(cx).inline_probe_snapshot().live)
    })
}
fn three_visible_readers(cx: &mut HeadlessAppContext) {
    for width in [680., 1100.] {
        for dark in [false, true] {
            let server = Server::new();
            cx.update(|cx| {
                crate::appearance::commit_appearance(
                    if dark {
                        crate::settings_state::AppearancePreference::Dark
                    } else {
                        crate::settings_state::AppearancePreference::Light
                    },
                    cx,
                )
            });
            let rows = ["three-a", "three-b", "three-c"]
                .into_iter()
                .enumerate()
                .map(|(ix, id)| {
                    let mut r = reference(id, 1);
                    r.kind = "visual".into();
                    Message::artifact(900 + ix as u64, r)
                })
                .collect();
            let (h, view) = cx.update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(1600.)),
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
                                rows,
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
                })
            });
            wait(cx, h, |cx| {
                let panes = t.read(cx).inline_probe_panes();
                panes.len() == 3
                    && panes.iter().all(|(_, p)| {
                        let s = p.read(cx).inline_probe_snapshot();
                        assert!(s.error.is_none(), "queued reader: {:?}", s.error);
                        s.scene.is_some() && s.live
                    })
            });
            wait(cx, h, |cx| {
                t.read(cx)
                    .inline_probe_panes()
                    .iter()
                    .all(|(_, p)| p.read(cx).inline_probe_idle())
            });
            if let Some(dir) =
                std::env::var_os("PILOT_NEXT_INLINE_DIR").map(std::path::PathBuf::from)
            {
                std::fs::create_dir_all(&dir).unwrap();
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("three-{width}-{dark}-inline.png")))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                for id in 900u64..903 {
                    let scope = w.within(("message", id));
                    let b = scope.find("inline-visual").bounds();
                    assert!(b.size.width > px(300.) && b.size.height > px(400.));
                }
                w.within(("message", 902u64)).click("0.1.2", cx);
            })
            .unwrap();
            wait(cx, h, |cx| {
                t.read(cx)
                    .inline_probe_panes()
                    .iter()
                    .find(|(r, _)| r.id == "three-c")
                    .is_some_and(|(_, p)| {
                        p.read(cx)
                            .inline_probe_snapshot()
                            .state
                            .is_some_and(|s| s.contains("\"clicks\":1"))
                    })
            });
            let p = cx.update(|cx| {
                t.read(cx)
                    .inline_probe_panes()
                    .into_iter()
                    .find(|(r, _)| r.id == "three-c")
                    .unwrap()
                    .1
            });
            cx.update_window(h, |_, w, cx| {
                w.within(("message", 902u64)).click("inline-expand", cx)
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                w.click("reader-actual", cx);
                w.click("reader-in", cx);
            })
            .unwrap();
            wait(cx, h, |cx| p.read(cx).inline_probe_idle());
            cx.update_window(h, |_, w, cx| {
                let b = w.find("chart-plot").bounds();
                assert!(
                    b.size.height >= px(199.),
                    "native chart height grows, not a bitmap"
                );
                w.click("0.1.2", cx);
            })
            .unwrap();
            wait(cx, h, |cx| {
                let s = p.read(cx).inline_probe_snapshot();
                assert!(s.error.is_none(), "scaled dispatch: {:?}", s.error);
                s.state.is_some_and(|s| s.contains("\"clicks\":2"))
            });
            cx.update_window(h, |_, w, cx| {
                w.click("reader-reset", cx);
                w.click("artifact-copy-source", cx);
                assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), SOURCE);
            })
            .unwrap();
            wait(cx, h, |cx| p.read(cx).inline_probe_idle());
            if let Some(dir) =
                std::env::var_os("PILOT_NEXT_INLINE_DIR").map(std::path::PathBuf::from)
            {
                std::fs::create_dir_all(&dir).unwrap();
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("three-{width}-{dark}-expanded.png")))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| w.click("artifact-gallery", cx))
                .unwrap();
            frame(cx, h);
            cx.update(|cx| {
                t.update(cx, |t, cx| {
                    let mut rows: Vec<_> = ["raster-a", "raster-b", "raster-c"]
                        .into_iter()
                        .enumerate()
                        .map(|(ix, id)| {
                            let mut r = reference(id, 1);
                            r.kind = "image".into();
                            Message::artifact(950 + ix as u64, r)
                        })
                        .collect();
                    rows.extend((960..990).map(|id| {
                        Message::live(id, "Assistant".into(), "Readable text\n".repeat(12))
                    }));
                    t.replace_readonly(rows, true, cx);
                    t.inline_probe_scroll(0, cx);
                })
            });
            wait(cx, h, |cx| {
                let panes = t.read(cx).inline_probe_panes();
                panes.len() == 3
                    && panes.iter().all(|(_, p)| {
                        let s = p.read(cx).inline_probe_snapshot();
                        assert!(s.error.is_none(), "queued raster artifact: {:?}", s.error);
                        s.raster.is_some()
                    })
            });
            // Decoded rasters stay bound offscreen. Returning paints them in the
            // same frame, without another read, reload or placeholder height.
            let reads = server.reads.lock().unwrap().len();
            let rows = |cx: &mut HeadlessAppContext| {
                cx.update_window(h, |_, w, _| {
                    (950u64..953)
                        .map(|id| {
                            let scope = w.within(("message", id));
                            assert!(scope.try_find("artifact-raster-pixels").is_some());
                            scope.find("inline-visual").bounds().size
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap()
            };
            let shown = rows(cx);
            cx.update(|cx| t.update(cx, |t, cx| t.inline_probe_scroll(32, cx)));
            for _ in 0..8 {
                frame(cx, h);
            }
            cx.update_window(h, |_, w, _| {
                assert!(
                    w.find_all("artifact-raster-pixels").is_empty(),
                    "scrolled out"
                );
            })
            .unwrap();
            cx.update(|cx| t.update(cx, |t, cx| t.inline_probe_scroll(0, cx)));
            frame(cx, h);
            assert_eq!(shown, rows(cx), "re-entry keeps raster geometry");
            assert_eq!(
                server.reads.lock().unwrap().len(),
                reads,
                "no reload on re-entry"
            );
            if let Some(dir) =
                std::env::var_os("PILOT_NEXT_INLINE_DIR").map(std::path::PathBuf::from)
            {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("three-{width}-{dark}-raster.png")))
                    .unwrap();
            }
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
        }
    }
}
pub fn run_inline_visual_probe(cx: &mut HeadlessAppContext) {
    if std::env::var_os("PILOT_NEXT_ARTIFACT_SCROLL_DIR").is_some() {
        scroll::run(cx);
        return;
    }
    three_visible_readers(cx);
    let captures = std::env::var_os("PILOT_NEXT_INLINE_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    for width in [680., 1100.] {
        for dark in [false, true] {
            let server = Server::new();
            cx.update(|cx| {
                crate::appearance::commit_appearance(
                    if dark {
                        crate::settings_state::AppearancePreference::Dark
                    } else {
                        crate::settings_state::AppearancePreference::Light
                    },
                    cx,
                )
            });
            let (h, view) = cx.update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(840.)),
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
                                rows(),
                                w,
                                cx,
                            )
                        })
                    },
                )
                .unwrap()
            });
            let t = cx.update(|cx| view.read(cx).inline_probe_transcript());
            frame(cx, h);
            assert!(
                server.reads.lock().unwrap().is_empty(),
                "hydration alone cannot read/evaluate source"
            );
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{width}-{dark}-before.png")))
                    .unwrap();
            }
            cx.update(|cx| {
                view.update(cx, |v, cx| {
                    v.inline_probe_enable(server.options.clone(), cx)
                })
            });
            frame(cx, h);
            wait(cx, h, |cx| ready(&t, cx));
            let p = cx.update(|cx| pane(&t, cx).unwrap());
            let initial = cx.update(|cx| p.read(cx).inline_probe_snapshot());
            assert_eq!(initial.revision.as_ref().unwrap().reference.revision, 1);
            let guard = cx.update(|cx| t.read(cx).history_guard.clone());
            cx.update(|cx| t.update(cx, |t, _| t.history_guard = Some(Rc::new(|_, _| false))));
            cx.update_window(h, |_, w, cx| w.click_at("0.1.0", point(px(7.), px(7.)), cx))
                .unwrap();
            frame(cx, h);
            assert_eq!(
                cx.update(|cx| p.read(cx).inline_probe_snapshot().version),
                initial.version,
                "composition/navigation admission fences sibling controls"
            );
            cx.update(|cx| t.update(cx, |t, _| t.history_guard = guard));
            assert_eq!(
                server.reads.lock().unwrap().as_slice(),
                &[("study".into(), 1)]
            );
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{width}-{dark}-loaded.png")))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                let b = w.find("inline-visual").bounds();
                assert!(b.size.width > px(300.) && b.right() <= px(width));
                assert!(
                    (f32::from(b.size.height) - crate::artifact_view::inline_visual::HEIGHT).abs()
                        < 1.
                );
                assert!(!w.find("0.1.0").disabled().unwrap_or(false));
                w.click_at("0.1.0", point(px(7.), px(7.)), cx);
            })
            .unwrap();
            wait(cx, h, |cx| {
                p.read(cx).inline_probe_snapshot().version > initial.version
            });
            assert!(cx.update(|cx| {
                p.read(cx)
                    .inline_probe_snapshot()
                    .state
                    .unwrap()
                    .contains("\"on\":true")
            }));
            cx.update_window(h, |_, w, cx| w.click("0.1.1-1", cx))
                .unwrap();
            wait(cx, h, |cx| {
                p.read(cx)
                    .inline_probe_snapshot()
                    .state
                    .as_ref()
                    .is_some_and(|s| s.contains("Month"))
            });
            cx.update_window(h, |_, w, cx| w.click("0.1.2", cx))
                .unwrap();
            wait(cx, h, |cx| {
                p.read(cx)
                    .inline_probe_snapshot()
                    .state
                    .as_ref()
                    .is_some_and(|s| s.contains("\"clicks\":1"))
            });
            cx.update_window(h, |_, w, cx| {
                assert!(
                    w.try_find("inline-source").is_none(),
                    "inline header has only Expand"
                );
                w.click_at("0.0", point(px(5.), px(5.)), cx);
            })
            .unwrap();
            frame(cx, h);
            for _ in 0..12 {
                let focused = cx
                    .update_window(h, |_, w, cx| {
                        w.press("tab", cx);
                        w.find("0.1.2").focused() == Some(true)
                    })
                    .unwrap();
                frame(cx, h);
                if focused {
                    break;
                }
            }
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    w.find("0.1.2").focused(),
                    Some(true),
                    "Tab must reach the native Compare button"
                );
                w.press("space", cx);
            })
            .unwrap();
            wait(cx, h, |cx| {
                p.read(cx)
                    .inline_probe_snapshot()
                    .state
                    .as_ref()
                    .is_some_and(|s| s.contains("\"clicks\":2"))
            });
            cx.update_window(h, |_, w, cx| {
                w.click("0.3-plus", cx);
            })
            .unwrap();
            wait(cx, h, |cx| {
                p.read(cx)
                    .inline_probe_snapshot()
                    .state
                    .as_ref()
                    .is_some_and(|s| s.contains("\"n\":5"))
            });
            cx.update_window(h, |_, w, cx| {
                let thumb = w.within("0.3-slider").find(("slider-thumb", 0u32)).bounds();
                let track = w.find("0.3-slider").bounds();
                w.drag(
                    thumb.center(),
                    point(track.left() + track.size.width * 0.85, thumb.center().y),
                    cx,
                );
            })
            .unwrap();
            wait(cx, h, |cx| {
                p.read(cx)
                    .inline_probe_snapshot()
                    .scene
                    .as_ref()
                    .is_some_and(|s| {
                        s.root["children"][3]["value"]
                            .as_f64()
                            .is_some_and(|n| n >= 8.)
                    })
            });
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{width}-{dark}-inline.png")))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                w.scroll(
                    "inline-visual-content",
                    ScrollDelta::Pixels(point(px(0.), px(-300.))),
                    cx,
                )
            })
            .unwrap();
            wait(cx, h, |cx| {
                p.read(cx)
                    .inline_probe_snapshot()
                    .drawings
                    .get("0.5")
                    .is_some_and(|frame| frame.plan.is_ok())
            });
            cx.update_window(h, |_, w, _| {
                let canvas = w.find("0.5").bounds();
                let viewport = w.find("inline-visual-content").bounds();
                assert!(
                    canvas.bottom() <= viewport.bottom() + px(1.) && canvas.top() >= viewport.top()
                );
                assert!(w.find("0.4-1-0").bounds().size.width > px(0.));
            })
            .unwrap();
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{width}-{dark}-canvas-table.png")))
                    .unwrap();
            }
            let state = cx.update(|cx| p.read(cx).inline_probe_snapshot().state);
            cx.update_window(h, |_, w, cx| w.click("inline-expand", cx))
                .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, _| {
                assert!(w.find("artifact-detail").bounds().size.width > px(300.));
            })
            .unwrap();
            cx.update_window(h, |_, w, cx| w.click("artifact-source", cx))
                .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| w.click("artifact-copy-source", cx))
                .unwrap();
            assert_eq!(
                cx.update(|cx| cx.read_from_clipboard().unwrap().text().unwrap()),
                SOURCE
            );
            cx.update_window(h, |_, w, cx| {
                cx.write_to_clipboard(ClipboardItem::new_string("selection sentinel".into()));
                w.click_with_options(
                    "artifact-source-text",
                    gpui_kit::test::ClickOptions::new()
                        .with_offset(point(px(35.), px(8.)))
                        .with_count(2),
                    cx,
                );
                w.press("secondary-c", cx);
            })
            .unwrap();
            frame(cx, h);
            let selected = cx.update(|cx| cx.read_from_clipboard().unwrap().text().unwrap());
            assert!(
                !selected.is_empty()
                    && SOURCE.contains(&selected)
                    && selected != "selection sentinel",
                "native source selection/copy remains usable"
            );
            cx.update_window(h, |_, w, cx| w.click("artifact-source", cx))
                .unwrap();
            frame(cx, h);

            assert_eq!(
                cx.update(|cx| p.read(cx).inline_probe_snapshot().state),
                state,
                "same reader transfers without resetting state"
            );
            assert_eq!(
                server.reads.lock().unwrap().len(),
                1,
                "expand must not open a duplicate reader"
            );
            cx.update_window(h, |_, w, cx| w.click("artifact-gallery", cx))
                .unwrap();
            wait(cx, h, |cx| ready(&t, cx));
            assert_eq!(
                cx.update(|cx| pane(&t, cx).unwrap().read(cx).inline_probe_snapshot().state),
                state
            );
            // Revision changes, history prepend and streaming replacement preserve exact provenance.
            cx.update_window(h, |_, w, cx| t.update(cx, |t, cx| t.open_find(w, cx)))
                .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| w.input("regions", cx))
                .unwrap();
            wait(cx, h, |cx| {
                let view = t.read(cx);
                view.transcript
                    .messages()
                    .iter()
                    .find(|r| r.id() == 1)
                    .is_some_and(|row| view.find_context(row).is_some())
            });
            cx.update_window(h, |_, w, cx| w.press("escape", cx))
                .unwrap();
            frame(cx, h);
            cx.update(|cx| {
                t.update(cx, |t, cx| {
                    let mut rows = rows();
                    rows.insert(
                        0,
                        Message::live(99, "Assistant".into(), "Earlier context".into()),
                    );
                    t.replace_readonly(rows, false, cx);
                })
            });
            frame(cx, h);
            assert!(cx.update(|cx| t.read(cx).inline_probe_panes().len() <= 2));
            cx.update(|cx| {
                t.update(cx, |t, cx| {
                    t.replace_readonly(vec![Message::artifact(2, reference("study", 2))], true, cx);
                })
            });
            wait(cx, h, |cx| {
                pane(&t, cx).is_some_and(|p| {
                    p.read(cx)
                        .inline_probe_snapshot()
                        .revision
                        .as_ref()
                        .is_some_and(|r| r.reference.revision == 2)
                })
            });
            assert!(server.reads.lock().unwrap().iter().any(|(_, r)| *r == 2));
            // Scroll offscreen to plain content: source execution is no longer retained.
            cx.update(|cx| {
                t.update(cx, |t, cx| {
                    let mut rows = vec![Message::artifact(2, reference("study", 2))];
                    rows.extend((10..40).map(|id| {
                        Message::live(
                            id,
                            "Assistant".into(),
                            "Plain conversation content.\n".repeat(8),
                        )
                    }));
                    t.replace_readonly(rows, true, cx);
                    t.inline_probe_scroll(30, cx);
                })
            });
            wait(cx, h, |cx| t.read(cx).inline_probe_panes().is_empty());
            assert!(cx.update(|cx| p.read(cx).inline_probe_snapshot().scene.is_none()));
            cx.update(|cx| {
                t.update(cx, |t, cx| {
                    t.replace_readonly(
                        vec![
                            Message::artifact(60, reference("study-a", 1)),
                            Message::artifact(61, reference("study-b", 1)),
                            Message::artifact(62, reference("study-a", 1)),
                            Message::artifact(63, reference("study-c", 1)),
                        ],
                        true,
                        cx,
                    );
                    t.inline_probe_scroll(0, cx);
                })
            });
            frame(cx, h);
            wait(cx, h, |cx| {
                let panes = t.read(cx).inline_probe_panes();
                for (reference, p) in &panes {
                    assert!(
                        p.read(cx).inline_probe_snapshot().error.is_none(),
                        "multiple {reference:?}: {:?}",
                        p.read(cx).inline_probe_snapshot().error
                    );
                }
                panes.len() == 2
                    && panes
                        .iter()
                        .all(|(_, p)| p.read(cx).inline_probe_snapshot().live)
            });
            assert!(cx.update(|cx| t.read(cx).inline_visuals.entries.len() <= CACHED));
            assert_eq!(
                server
                    .reads
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|(id, _)| id == "study-a")
                    .count(),
                1,
                "duplicate pins never duplicate helpers"
            );
            cx.update(|cx| {
                t.update(cx, |t, cx| {
                    t.replace_readonly(
                        vec![Message::artifact(50, reference("broken", 1))],
                        true,
                        cx,
                    )
                })
            });
            wait(cx, h, |cx| {
                pane(&t, cx).is_some_and(|p| p.read(cx).inline_probe_snapshot().error.is_some())
            });
            cx.update_window(h, |_, w, _| {
                assert!(w.find("inline-retry").bounds().size.width > px(0.));
            })
            .unwrap();
            cx.update(|cx| {
                t.update(cx, |t, cx| {
                    t.replace_readonly(
                        vec![Message::artifact(51, reference("legacy", 1))],
                        true,
                        cx,
                    )
                })
            });
            wait(cx, h, |cx| {
                pane(&t, cx).is_some_and(|p| {
                    p.read(cx)
                        .inline_probe_snapshot()
                        .revision
                        .as_ref()
                        .is_some_and(|r| r.reference.kind == "html")
                })
            });
            assert!(cx.update(|cx| {
                let snapshot = pane(&t, cx).unwrap().read(cx).inline_probe_snapshot();
                snapshot.scene.is_none() && snapshot.error.is_none()
            }));

            cx.update(|cx| {
                t.update(cx, |t, cx| {
                    t.replace_readonly(
                        vec![Message::artifact(80, reference("raster", 1))],
                        true,
                        cx,
                    )
                })
            });
            wait(cx, h, |cx| {
                pane(&t, cx).is_some_and(|p| p.read(cx).inline_probe_snapshot().raster.is_some())
            });
            let raster_bounds = cx
                .update_window(h, |_, w, _| w.find("artifact-raster-pixels").bounds())
                .unwrap();
            assert_eq!(
                raster_bounds.size,
                size(px(48.), px(48.)),
                "tiny raster keeps Swift's minimum target, not a fixed card"
            );
            cx.update_window(h, |_, w, _| {
                assert!(w.find("inline-visual").bounds().size.height < px(120.));
            })
            .unwrap();
            let shot = cx.capture_screenshot(h).unwrap();
            let scale = shot.width() as f32 / width;
            assert_eq!(
                shot.get_pixel(
                    (f32::from(raster_bounds.center().x) * scale) as u32,
                    (f32::from(raster_bounds.center().y) * scale) as u32
                )
                .0[..3],
                [24, 110, 220],
                "native inline image uses the existing actual-size containment path"
            );
            if let Some(dir) = &captures {
                shot.save(dir.join(format!("{width}-{dark}-image.png")))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| w.click("artifact-raster-viewport", cx))
                .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| w.click("artifact-source", cx))
                .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| w.click("artifact-copy-source", cx))
                .unwrap();
            wait(cx, h, |cx| {
                cx.read_from_clipboard().and_then(|c| c.text()).as_deref()
                    == Some(server.raster.as_str())
            });

            cx.update_window(h, |_, w, cx| w.click("artifact-gallery", cx))
                .unwrap();
            frame(cx, h);
            cx.update(|cx| {
                t.update(cx, |t, cx| {
                    t.replace_readonly(
                        vec![Message::artifact(81, reference("raster-gif", 1))],
                        true,
                        cx,
                    )
                })
            });
            wait(cx, h, |cx| {
                pane(&t, cx).is_some_and(|p| {
                    p.read(cx)
                        .inline_probe_snapshot()
                        .raster
                        .as_ref()
                        .is_some_and(|r| r.first_frame)
                })
            });
            cx.update_window(h, |_, w, _| {
                assert!(w.find("inline-image-frame-note").bounds().size.height > px(0.))
            })
            .unwrap();
            if width == 680. && !dark {
                for index in 0..9 {
                    let reference = reference(&format!("cache-{index}"), 1);
                    cx.update(|cx| {
                        t.update(cx, |t, cx| {
                            t.replace_readonly(
                                vec![Message::artifact(100 + index, reference)],
                                true,
                                cx,
                            )
                        })
                    });
                    wait(cx, h, |cx| ready(&t, cx));
                    assert!(cx.update(|cx| t.read(cx).inline_visuals.entries.len() <= CACHED));
                }
                assert!(
                    !cx.update(|cx| t
                        .read(cx)
                        .inline_visuals
                        .entries
                        .iter()
                        .any(|e| e.reference.id == "cache-0")),
                    "closed state cache evicts rather than growing with history"
                );
            }
            cx.update_window(h, |_, w, _| w.remove_window()).unwrap();
            cx.run_until_parked();
            println!(
                "inline_visual {width} dark={dark}: pinned helper, pointer/keyboard controls, slider drag, table/canvas, source, transfer, revision, prepend, offscreen, error, inert legacy passed"
            );
        }
    }
    println!("inline_visual: 4 mounted matrix records passed");
}
