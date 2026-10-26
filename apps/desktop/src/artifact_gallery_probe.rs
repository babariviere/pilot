//! Actual synthetic mounted gallery. Never reads a real Local profile or executes preview source.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use gpui_kit::{
    AnyWindowHandle, Bounds, HeadlessAppContext, ScrollDelta, WindowBounds, WindowOptions,
    component::ThemeMode, point, size, test::TestWindowExt,
};
use serde_json::json;
use std::{io::Cursor, sync::Mutex, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

fn reference(ix: usize, revision: u32) -> Reference {
    Reference {
        id: format!("tile-{ix}"),
        session: "owner".into(),
        revision,
        title: match ix {
            0 | 1 => "同じ名前 · Stored study".into(),
            8 => "研究 🧪 résumé العربية ".repeat(10),
            _ => format!("Stored artifact {ix}"),
        },
        kind: match ix {
            2 => "visual",
            3 => "swiftui",
            5 => "html",
            6 => "shader",
            7 => "react",
            _ => "image",
        }
        .into(),
    }
}
fn index(p: &mut ArtifactPane, items: Vec<Reference>, cx: &mut Context<ArtifactPane>) {
    let wire=serde_json::Value::Array(items.iter().map(|r| json!({"id":r.id,"sessionId":r.session,"revision":r.revision,"kind":r.kind,"title":r.title})).collect());
    let mut metadata = Metadata::default();
    let canonical = metadata.accept(&wire, "owner").unwrap();
    p.context(Some("owner".into()), canonical, cx);
    p.artifact_metadata(metadata, cx);
}
fn encoded(color: [u8; 3]) -> String {
    let image =
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(512, 320, image::Rgb(color)));
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    format!(
        "data:image/png;base64,{}",
        STANDARD.encode(bytes.into_inner())
    )
}
struct Server {
    options: LocalOptions,
    requests: Arc<Mutex<Vec<(usize, u32)>>>,
    stop: Option<async_channel::Sender<()>>,
    done: std::sync::mpsc::Receiver<()>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    fn new() -> Self {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let options = LocalOptions::synthetic(listener.local_addr().unwrap().port());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let records = requests.clone();
        let (stop, closed) = async_channel::bounded(1);
        let (done, finished) = std::sync::mpsc::channel();
        let (blue, orange) = (
            Arc::new(encoded([24, 110, 220])),
            Arc::new(encoded([220, 90, 30])),
        );
        let thread = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async move {
                let listener=tokio::net::TcpListener::from_std(listener).unwrap();
                let mut handlers=tokio::task::JoinSet::new();
                loop {tokio::select!{biased;_=closed.recv()=>break,connection=listener.accept()=>{
                    let Ok((stream,_))=connection else {break;};let(records,blue,orange)=(records.clone(),blue.clone(),orange.clone());
                    handlers.spawn(async move {
                        let operation=async {
                            let mut stream=BufReader::new(stream);let mut headers=String::new();
                            loop{let mut line=String::new();if stream.read_line(&mut line).await?==0{return Ok::<(),std::io::Error>(());}headers.push_str(&line);if headers.len()>8192{return Ok(());}
                                if line=="\r\n"{break;}}
                            assert!(!headers.to_lowercase().contains("authorization:")&&!headers.to_lowercase().contains("cookie:"));
                            let request=headers.lines().next().unwrap();assert!(request.starts_with("GET "));
                            let path=request.split_whitespace().nth(1).unwrap();
                            let body=if path=="/api/hello"{json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}})}
                            else {
                                let tail=path.strip_prefix("/api/sessions/owner/artifacts/tile-").expect("only scoped reads");
                                let(ix,revision)=tail.split_once("?revision=").unwrap();let(ix,revision)=(ix.parse::<usize>().unwrap(),revision.parse::<u32>().unwrap());
                                assert!(ix<64&&(1..=2).contains(&revision));let r=reference(ix,revision);
                                assert_eq!(r.kind,"image","gallery must not fetch generated/deferred sources");
                                records.lock().unwrap().push((ix,revision));
                                let source=if ix==4{"data:image/webp;base64,AAAA"}else if ix%2==1||revision==2{orange.as_str()}else{blue.as_str()};
                                json!({"id":r.id,"sessionId":"owner","revision":revision,"title":r.title,"kind":"image","source":source,"html":"<script>never consumed</script>","createdAt":1,"updatedAt":2})
                            }.to_string();
                            let mut stream=stream.into_inner();
                            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).as_bytes()).await?;
                            stream.write_all(body.as_bytes()).await?;Ok(())
                        };
                        let _=tokio::time::timeout(Duration::from_secs(2),operation).await;
                    });
                },_=handlers.join_next(),if !handlers.is_empty()=>{}}}
                handlers.abort_all();while handlers.join_next().await.is_some(){}
            });
            let _ = done.send(());
        });
        Self {
            options,
            requests,
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
            .expect("bounded faux server shutdown");
        self.thread.take().unwrap().join().unwrap();
    }
}
fn frame(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    cx.advance_clock(Duration::from_millis(16));
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
}
fn settle(cx: &mut HeadlessAppContext, h: AnyWindowHandle, p: &Entity<ArtifactPane>) {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        frame(cx, h);
        if cx.update(|cx| {
            let p = p.read(cx);
            p.gallery.geometry.is_some()
                && p.gallery.current.is_none()
                && p.gallery.start.is_none()
                && p.gallery.desired.iter().all(|r| {
                    p.gallery.cache.get(&Key::new(r)).is_some()
                        || p.gallery.errors.contains_key(&Key::new(r))
                })
        }) {
            break;
        }
        assert!(Instant::now() < deadline, "bounded gallery settle");
        std::thread::yield_now();
    }
}
fn detail(cx: &mut HeadlessAppContext, h: AnyWindowHandle, p: &Entity<ArtifactPane>) {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        frame(cx, h);
        if cx.update(|cx| {
            let p = p.read(cx);
            p.worker.is_none() && !p.busy && p.snapshot.complete
        }) {
            break;
        }
        assert!(Instant::now() < deadline, "bounded exact detail completion");
        std::thread::yield_now();
    }
}
fn painted(
    cx: &mut HeadlessAppContext,
    h: AnyWindowHandle,
    bounds: Bounds<gpui_kit::Pixels>,
    width: f32,
    color: [u8; 3],
) {
    let shot = cx.capture_screenshot(h).unwrap();
    let scale = shot.width() as f32 / width;
    let pixel = shot
        .get_pixel(
            (f32::from(bounds.center().x) * scale) as u32,
            (f32::from(bounds.center().y) * scale) as u32,
        )
        .0;
    assert!(
        pixel[..3].iter().zip(color).all(|(a, b)| a.abs_diff(b) < 5),
        "actual BGRA thumbnail/detail paint {pixel:?}"
    );
}
pub fn run_artifact_gallery_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_GALLERY_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
            let server = Server::new();
            cx.update(|cx| {
                crate::appearance::commit_appearance(
                    if mode == ThemeMode::Dark {
                        crate::settings_state::AppearancePreference::Dark
                    } else {
                        crate::settings_state::AppearancePreference::Light
                    },
                    cx,
                )
            });
            let (h, pane) = cx.update(|cx| {
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Default::default(),
                            size(px(width), px(760.)),
                        ))),
                        show: false,
                        focus: false,
                        ..Default::default()
                    },
                    cx,
                    |w, cx| {
                        cx.new(|cx| {
                            let mut p = ArtifactPane::new();
                            p.options = Some(server.options.clone());
                            index(&mut p, (0..128).map(|ix| reference(ix, 1)).collect(), cx);
                            p.show_gallery(w, cx);
                            p
                        })
                    },
                )
                .unwrap()
            });
            settle(cx, h, &pane);
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{}-{}-initial.png", width as u32, mode.name())))
                    .unwrap();
            }
            let first_bounds = cx
                .update_window(h, |_, w, cx| {
                    assert_eq!(cx.theme().mode, mode);
                    assert!((f32::from(w.viewport_size().width) - width).abs() < 1.);
                    let p = pane.read(cx);
                    assert!(p.gallery.cols >= 2);
                    assert!(p.gallery.metadata.is_limited() && p.items.len()==64);
                    assert!((p.gallery.geometry.unwrap().stride - 15. * f32::from(w.rem_size())).abs() < 1., "viewport height must never substitute for uniform row stride");
                    assert!(p.gallery.desired.len() <= 12);
                    assert!(
                        p.gallery.cache.usage().0 <= 12
                            && p.gallery.cache.usage().1 <= 8 * 1024 * 1024
                    );
                    assert!(p.gallery.errors.contains_key(&Key::new(&reference(4, 1))), "geometry={:?}; desired={:?}; cache={:?}; viewport={:?}; list={:?}; reads={:?}",
                        p.gallery.geometry, p.gallery.desired.iter().map(|r|r.id.as_str()).collect::<Vec<_>>(), p.gallery.cache.usage(),
                        w.find("artifact-gallery").bounds(), p.gallery.scroll.0.borrow().last_item_size, server.requests.lock().unwrap());
                    let first = w
                        .find(SharedString::from(Key::new(&reference(0, 1)).element_id()))
                        .bounds();
                    let second = w
                        .find(SharedString::from(Key::new(&reference(1, 1)).element_id()))
                        .bounds();
                    assert!(
                        first.origin.x < second.origin.x && first.origin.y == second.origin.y,
                        "same-title canonical tiles are distinct"
                    );
                    assert!(
                        first.origin.x >= px(0.)
                            && second.origin.x + second.size.width <= px(width)
                    );
                    w.find("gallery-preview-tile-0-1").bounds()
                })
                .unwrap();
            assert!(
                server.requests.lock().unwrap().len() <= 12,
                "no eager64-source reads"
            );
            painted(cx, h, first_bounds, width, [24, 110, 220]);
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{}-{}-gallery.png", width as u32, mode.name())))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                for _ in 0..8 {
                    w.press("right", cx);
                }
            })
            .unwrap();
            settle(cx, h, &pane);
            cx.update_window(h, |_, w, _| {
                let card = w
                    .find(SharedString::from(Key::new(&reference(8, 1)).element_id()))
                    .bounds();
                let title = w.find("gallery-title-tile-8-1").bounds();
                let preview = w.find("gallery-preview-tile-8-1").bounds();
                assert!(
                    title.origin.x >= card.origin.x
                        && title.origin.x + title.size.width <= card.origin.x + card.size.width
                );
                assert!(
                    (f32::from(title.origin.x - preview.origin.x)).abs() < 1.,
                    "title and preview share a leading spine"
                );
                assert!(
                    title.origin.y >= px(0.) && title.origin.y + title.size.height <= px(760.),
                    "long Unicode title must actually be mounted in the viewport"
                );
            })
            .unwrap();
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{}-{}-unicode.png", width as u32, mode.name())))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| w.press("home", cx)).unwrap();
            settle(cx, h, &pane);
            // Scoped keyboard navigation opens the second same-title canonical resource.
            cx.update_window(h, |_, w, cx| {
                w.press("right", cx);
                w.press("enter", cx);
            })
            .unwrap();
            detail(cx, h, &pane);
            cx.update_window(h, |_, w, cx| {
                let p = pane.read(cx);
                assert_eq!(p.reference.as_ref().unwrap().id, "tile-1");
                assert_eq!(p.snapshot.revision.as_ref().unwrap().reference.id, "tile-1");
                w.click("artifact-back", cx);
            })
            .unwrap();
            settle(cx, h, &pane);
            cx.update_window(h, |_, w, cx| {
                assert!(pane.read(cx).gallery.focus.as_ref().unwrap().is_focused(w));
            })
            .unwrap();
            let second = Key::new(&reference(1, 1)).element_id();
            for _ in 0..14 {
                if cx
                    .update_window(h, |_, w, _| {
                        w.find(SharedString::from(second.clone())).focused() == Some(true)
                    })
                    .unwrap()
                {
                    break;
                }
                cx.update_window(h, |_, w, cx| w.focus_next(cx)).unwrap();
                frame(cx, h);
            }
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    w.find(SharedString::from(second.clone())).focused(),
                    Some(true)
                );
                w.press("space", cx);
            })
            .unwrap();
            detail(cx, h, &pane);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(pane.read(cx).reference.as_ref().unwrap().id, "tile-1");
                w.click("artifact-back", cx);
            })
            .unwrap();
            settle(cx, h, &pane);
            // A real pointer click waits for an independently owned completion receiver.
            let (done, finished) = async_channel::bounded::<()>(1);
            cx.update_window(h, |_, w, cx| {
                pane.update(cx, |p, _| p.reader_drain(finished));
                w.click(
                    SharedString::from(Key::new(&reference(0, 1)).element_id()),
                    cx,
                );
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, _, cx| {
                pane.update(cx, |p, cx| {
                    assert!(p.busy && p.worker.is_none());
                    assert_eq!(p.reference.as_ref().unwrap().revision, 1);
                    let mut refs: Vec<_> = (0..64).map(|ix| reference(ix, 1)).collect();
                    refs[0].revision = 2;
                    index(p, refs, cx);
                    assert_eq!(
                        p.reference.as_ref().unwrap().revision,
                        1,
                        "latest refresh must not retarget clicked detail"
                    );
                })
            })
            .unwrap();
            drop(done);
            detail(cx, h, &pane);
            let bounds = cx
                .update_window(h, |_, w, cx| {
                    let p = pane.read(cx);
                    assert_eq!(
                        p.snapshot.revision.as_ref().unwrap().reference,
                        reference(0, 1)
                    );
                    assert!(p.snapshot.error.is_none());
                    w.find("artifact-raster-viewport").bounds()
                })
                .unwrap();
            painted(cx, h, bounds, width, [24, 110, 220]);
            cx.update_window(h, |_, w, cx| w.click("artifact-back", cx))
                .unwrap();
            settle(cx, h, &pane);
            let weak = cx.update(|cx| {
                Arc::downgrade(
                    &pane
                        .read(cx)
                        .gallery
                        .cache
                        .get(&Key::new(&reference(1, 1)))
                        .unwrap()
                        .image(),
                )
            });
            for (stage, delta) in [-2400., -10000.].into_iter().enumerate() {
                cx.update_window(h, |_, w, cx| {
                    w.scroll(
                        "artifact-gallery-viewport",
                        ScrollDelta::Pixels(point(px(0.), px(delta))),
                        cx,
                    )
                })
                .unwrap();
                settle(cx, h, &pane);
                let _ = cx.capture_screenshot(h).unwrap();
                if stage == 0 {
                    let (offset, chosen) = cx.update(|cx| {
                        let p = pane.read(cx);
                        let ix = (p.gallery.anchor_row + 1) * p.gallery.cols;
                        (
                            p.gallery.scroll.0.borrow().base_handle.offset(),
                            p.items[ix].clone(),
                        )
                    });
                    assert!(offset.y < px(0.), "fixture must be away from the top");
                    cx.update_window(h, |_, w, cx| {
                        w.click(SharedString::from(Key::new(&chosen).element_id()), cx)
                    })
                    .unwrap();
                    detail(cx, h, &pane);
                    cx.update_window(h, |_, w, cx| {
                        assert_eq!(pane.read(cx).reference.as_ref().unwrap(), &chosen);
                        w.click("artifact-back", cx);
                    })
                    .unwrap();
                    settle(cx, h, &pane);
                    cx.update(|cx| {
                        assert_eq!(
                            pane.read(cx).gallery.scroll.0.borrow().base_handle.offset(),
                            offset,
                            "Back must preserve non-top reader position"
                        )
                    });
                }
            }
            frame(cx, h);
            assert!(
                weak.upgrade().is_none(),
                "offscreen evicted thumbnail CPU handle must retire"
            );
            let requests = server.requests.lock().unwrap().clone();
            assert!(
                requests.len() < 64 && requests.iter().any(|(ix, _)| *ix > 50),
                "only visited ranges are requested"
            );
            cx.update_window(h, |_, _, cx| {
                pane.update(cx, |p, cx| {
                    assert!(
                        p.gallery.cache.usage().0 <= 12
                            && p.gallery.cache.usage().1 <= 8 * 1024 * 1024
                    );
                    let before = p.gallery.cache.usage();
                    let mut bad = p.gallery.metadata.clone();
                    assert!(bad.accept(&serde_json::Value::Null, "owner").is_none());
                    p.artifact_metadata(bad, cx);
                    assert_eq!(
                        p.gallery.cache.usage(),
                        before,
                        "invalid metadata retains usable pixels"
                    );
                    assert!(p.gallery.metadata.problem().is_some());
                })
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, _, cx| {
                pane.update(cx, |p, cx| {
                    index(p, Vec::new(), cx);
                    assert!(p.gallery.metadata.is_received() && p.items.is_empty());
                    assert_eq!(p.gallery.cache.usage(), (0, 0));
                    let mut stale = p.gallery.metadata.clone();
                    stale.mark_stale();
                    p.artifact_metadata(stale, cx);
                })
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, _, cx| {
                pane.update(cx, |p, cx| {
                    assert!(p.gallery.metadata.is_stale());
                    p.artifact_metadata(Metadata::default(), cx);
                })
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, _, cx| {
                pane.update(cx, |p, cx| {
                    p.context(Some("different-owner".into()), Arc::new(Vec::new()), cx);
                    assert!(
                        p.gallery.cache.usage() == (0, 0)
                            && p.reference.is_none()
                            && p.gallery.current.is_none()
                    );
                    assert!(
                        !p.gallery.metadata.is_received(),
                        "scope reset is not an empty received index"
                    );
                })
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(!pane.read(cx).gallery.metadata.is_received());
                w.remove_window();
            })
            .unwrap();
            cx.run_until_parked();
            println!(
                "artifact_gallery {} {} passed: lazy/exact/keyboard/pointer/paint/cache/metadata",
                width as u32,
                mode.name()
            );
        }
    }
}
