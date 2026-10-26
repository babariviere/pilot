//! Real selected-reader pipeline against an owned faux server, never Local data.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use gpui_kit::{
    AnyWindowHandle, Bounds, HeadlessAppContext, ScrollDelta, WindowBounds, WindowOptions,
    component::ThemeMode, point, size, test::TestWindowExt,
};
use std::{
    io::{BufRead, Cursor, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

const IMAGE_WIDTH: u32 = 2560;
const IMAGE_HEIGHT: u32 = 1600;
fn encoded(format: image::ImageFormat, color: [u8; 3]) -> String {
    let image = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        IMAGE_WIDTH,
        IMAGE_HEIGHT,
        image::Rgb(color),
    ));
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, format).unwrap();
    format!(
        "data:image/{};base64,{}",
        match format {
            image::ImageFormat::Png => "png",
            image::ImageFormat::Jpeg => "jpeg",
            image::ImageFormat::Gif => "gif",
            _ => unreachable!(),
        },
        STANDARD.encode(bytes.into_inner())
    )
}
fn reference(id: &str, revision: u32) -> Reference {
    Reference {
        id: id.into(),
        session: "owner".into(),
        title: format!("Synthetic {id}"),
        kind: "image".into(),
        revision,
    }
}
struct Server {
    options: LocalOptions,
    port: u16,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    requests: Arc<Mutex<Vec<String>>>,
    source: String,
}
impl Server {
    fn start() -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let source = encoded(image::ImageFormat::Png, [24, 110, 220]);
        let sources = BTreeMap::from([
            (("synthetic", 2), source.clone()),
            (
                ("synthetic", 1),
                encoded(image::ImageFormat::Png, [220, 90, 30]),
            ),
            (
                ("jpeg", 1),
                encoded(image::ImageFormat::Jpeg, [24, 110, 220]),
            ),
            (("gif", 1), encoded(image::ImageFormat::Gif, [24, 110, 220])),
            (("webp", 1), "data:image/webp;base64,AAAA".into()),
            (("broken", 1), "data:image/png;base64,iVBORw0KGgo=".into()),
        ]);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let records = requests.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let thread = std::thread::spawn(move || {
            for stream in listener.incoming() {
                if stopped.load(Ordering::Acquire) {
                    break;
                }
                let mut stream = stream.unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let result = (|| -> std::io::Result<()> {
                    let mut headers = String::new();
                    let mut reader = std::io::BufReader::new((&mut stream).take(8192));
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line)? == 0 {
                            break;
                        }
                        headers.push_str(&line);
                        if line == "\r\n" {
                            break;
                        }
                    }
                    let request = headers.lines().next().unwrap_or("").to_string();
                    records.lock().unwrap().push(request.clone());
                    assert!(request.starts_with("GET "));
                    assert!(!headers.to_lowercase().contains("authorization:"));
                    let path = request.split_whitespace().nth(1).unwrap();
                    let value = if path == "/api/hello" {
                        json!({"daemonId":"test-daemon","lineageId":"test-lineage","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}})
                    } else {
                        let tail = path
                            .strip_prefix("/api/sessions/owner/artifacts/")
                            .expect("scoped route only");
                        let (id, revision) = tail.split_once("?revision=").unwrap();
                        let revision = revision.parse::<u32>().unwrap();
                        let source = sources
                            .get(&(id, revision))
                            .expect("known synthetic revision");
                        json!({"id":id,"sessionId":"owner","revision":revision,"title":format!("Synthetic {id}"),"kind":"image","source":source,"html":"<script>never evaluate prepared HTML</script>","createdAt":1,"updatedAt":2,"visual":{"api":1,"engine":"quickjs-ng 0.17.0"}})
                    };
                    let body = value.to_string();
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )?;
                    Ok(())
                })();
                let _ = result;
            }
        });
        Self {
            options: LocalOptions::synthetic(port),
            port,
            stop,
            thread: Some(thread),
            requests,
            source,
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, self.port));
        self.thread.take().unwrap().join().unwrap();
    }
}
fn frame(cx: &mut HeadlessAppContext, h: AnyWindowHandle) {
    cx.advance_clock(Duration::from_millis(16));
    cx.run_until_parked();
    cx.update_window(h, |_, w, cx| w.render_frame(cx)).unwrap();
}
fn loaded(cx: &mut HeadlessAppContext, h: AnyWindowHandle, p: &Entity<ArtifactPane>) {
    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        frame(cx, h);
        if cx.update(|cx| p.read(cx).worker.is_none() && !p.read(cx).busy) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "bounded stored-image reader completion"
        );
        std::thread::yield_now();
    }
}
pub fn run_artifact_image_probe(cx: &mut HeadlessAppContext) {
    let captures = std::env::var_os("PILOT_NEXT_IMAGE_DIR").map(std::path::PathBuf::from);
    if let Some(dir) = &captures {
        std::fs::create_dir_all(dir).unwrap();
    }
    let server = Server::start();
    for width in [680., 1100.] {
        for mode in [ThemeMode::Light, ThemeMode::Dark] {
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
                            p.context(
                                Some("owner".into()),
                                Arc::new(vec![reference("synthetic", 2)]),
                                cx,
                            );
                            p.open(reference("synthetic", 2), w, cx);
                            p
                        })
                    },
                )
                .unwrap()
            });
            loaded(cx, h, &pane);
            let viewport = cx
                .update_window(h, |_, w, cx| {
                    assert_eq!(cx.theme().mode, mode);
                    assert!((f32::from(w.viewport_size().width) - width).abs() < 1.);
                    let p = pane.read(cx);
                    assert!(
                        p.snapshot.complete
                            && p.snapshot.error.is_none()
                            && p.snapshot.scene.is_none()
                            && p.snapshot.state.is_none()
                    );
                    let r = p.snapshot.raster.as_ref().unwrap();
                    assert_eq!((r.width, r.height), (IMAGE_WIDTH, IMAGE_HEIGHT));
                    assert_eq!(r.image.frame_count(), 1);
                    cx.write_to_clipboard(ClipboardItem::new_string("sentinel".into()));
                    w.find("artifact-raster-viewport").bounds()
                })
                .unwrap();
            let shot = cx.capture_screenshot(h).unwrap();
            let scale = shot.width() as f32 / width;
            let pixel = shot
                .get_pixel(
                    (f32::from(viewport.center().x) * scale) as u32,
                    (f32::from(viewport.center().y) * scale) as u32,
                )
                .0;
            for (a, b) in pixel[..3].iter().zip([24u8, 110, 220]) {
                assert!(a.abs_diff(b) < 5, "BGRA paint: {pixel:?}");
            }
            if let Some(dir) = &captures {
                shot.save(dir.join(format!("{}-{}-fit.png", width as u32, mode.name())))
                    .unwrap();
            }
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    "sentinel"
                );
                w.click("artifact-image-scale", cx);
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(pane.read(cx).image_actual);
                let b = w.find("artifact-raster-pixels").bounds();
                assert!(
                    (f32::from(b.size.width) - IMAGE_WIDTH as f32 / w.scale_factor()).abs() < 1.
                );
                assert!(
                    b.size.width > viewport.size.width && b.size.height > viewport.size.height,
                    "fixture must actually overflow both axes"
                );
            })
            .unwrap();
            if let Some(dir) = &captures {
                cx.capture_screenshot(h)
                    .unwrap()
                    .save(dir.join(format!("{}-{}-actual.png", width as u32, mode.name())))
                    .unwrap();
            }
            let before_scroll = cx
                .update_window(h, |_, w, cx| {
                    let b = w.find("artifact-raster-pixels").bounds();
                    w.scroll(
                        "artifact-raster-viewport",
                        ScrollDelta::Pixels(point(px(-120.), px(0.))),
                        cx,
                    );
                    // GPUI defaults to a dominant axis for a diagonal event.
                    // Exercise each native axis separately, without changing
                    // the production gesture policy to satisfy the fixture.
                    w.scroll(
                        "artifact-raster-viewport",
                        ScrollDelta::Pixels(point(px(0.), px(-100.))),
                        cx,
                    );
                    b.origin
                })
                .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, _| {
                let after = w.find("artifact-raster-pixels").bounds().origin;
                assert!(
                    after.x < before_scroll.x && after.y < before_scroll.y,
                    "actual-size viewport must scroll both axes"
                );
            })
            .unwrap();
            // Pointer activation does not promise keyboard focus on macOS.
            // Traverse native tab stops and assert the actual focused control
            // before testing its keyboard activation, rather than guessing.
            for _ in 0..8 {
                if cx
                    .update_window(h, |_, w, _| {
                        w.find("artifact-image-scale").focused() == Some(true)
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
                    w.find("artifact-image-scale").focused(),
                    Some(true),
                    "scale must be reachable through native tab traversal"
                );
                w.press("space", cx);
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(!pane.read(cx).image_actual, "native keyboard scale toggle");
                assert_eq!(
                    w.find("artifact-raster-pixels").bounds(),
                    w.find("artifact-raster-viewport").bounds(),
                    "fit mode clears actual-size scroll displacement"
                );
                w.click("artifact-source", cx);
            })
            .unwrap();
            frame(cx, h);
            cx.update_window(h, |_, w, cx| {
                assert!(pane.read(cx).source);
                let p = pane.read(cx);
                assert_eq!(
                    p.snapshot.revision.as_ref().unwrap().source.as_str(),
                    server.source
                );
                assert!(
                    !gpui_kit::base::TextSelection::selected_text(w, cx).contains("data:image")
                );
                w.click("artifact-copy-source", cx);
            })
            .unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            while cx.update(|cx| pane.read(cx).source_copy.is_some()) {
                assert!(Instant::now() < deadline);
                frame(cx, h);
            }
            let old_image = cx.update(|cx| {
                pane.read(cx)
                    .snapshot
                    .raster
                    .as_ref()
                    .unwrap()
                    .image
                    .clone()
            });
            let old_pixels = Arc::downgrade(&old_image);
            let old_image_id = old_image.id;
            drop(old_image);
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    server.source
                );
                w.click("artifact-previous", cx);
            })
            .unwrap();
            loaded(cx, h, &pane);
            cx.update_window(h, |_, _, cx| {
                assert_eq!(pane.read(cx).reference.as_ref().unwrap().revision, 1);
                assert!(pane.read(cx).snapshot.error.is_none());
                assert!(pane.read(cx).retired_image.is_none());
                assert_ne!(
                    pane.read(cx).snapshot.raster.as_ref().unwrap().image.id,
                    old_image_id
                );
            })
            .unwrap();
            // Native MetalAtlas inherits PlatformAtlas::contains() == false.
            // Its test-support query cannot prove GPU retirement. Check real
            // replacement paint and decoded-pixel ownership instead; GPU release
            // uses the separately source-audited App::drop_image API contract.
            frame(cx, h);
            assert!(
                old_pixels.upgrade().is_none(),
                "old decoded pixels must not remain cached after revision replacement"
            );
            let previous = cx.capture_screenshot(h).unwrap();
            let pixel = previous
                .get_pixel(
                    (f32::from(viewport.center().x) * scale) as u32,
                    (f32::from(viewport.center().y) * scale) as u32,
                )
                .0;
            for (a, b) in pixel[..3].iter().zip([220u8, 90, 30]) {
                assert!(a.abs_diff(b) < 5, "replacement revision paint: {pixel:?}");
            }
            cx.update_window(h, |_, w, cx| w.click("artifact-back", cx))
                .unwrap();
            frame(cx, h);
            for (id, ok) in [
                ("jpeg", true),
                ("gif", true),
                ("webp", false),
                ("broken", false),
            ] {
                cx.update_window(h, |_, w, cx| {
                    pane.update(cx, |p, cx| p.open(reference(id, 1), w, cx))
                })
                .unwrap();
                loaded(cx, h, &pane);
                cx.update(|cx| {
                    let p = pane.read(cx);
                    assert_eq!(p.snapshot.raster.is_some(), ok);
                    assert_eq!(p.snapshot.error.is_none(), ok);
                    if id == "gif" {
                        assert!(p.snapshot.raster.as_ref().unwrap().first_frame);
                    }
                    if id == "webp" {
                        assert!(
                            p.snapshot
                                .error
                                .as_ref()
                                .unwrap()
                                .message
                                .contains("WebP preview is unavailable")
                        );
                    }
                });
            }
            cx.update_window(h, |_, w, cx| {
                cx.write_to_clipboard(ClipboardItem::new_string("late-sentinel".into()));
                w.click("artifact-copy-source", cx);
                pane.update(cx, |p, cx| {
                    p.close();
                    p.flush_image(w, cx);
                    p.context(Some("other".into()), Arc::new(Vec::new()), cx);
                });
            })
            .unwrap();
            for _ in 0..4 {
                frame(cx, h);
            }
            cx.update_window(h, |_, w, cx| {
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    "late-sentinel",
                    "copy completion cannot cross close/chat switch"
                );
                pane.update(cx, |p, cx| {
                    p.close();
                    p.flush_image(w, cx);
                    assert!(p.retired_image.is_none() && p.snapshot.raster.is_none());
                });
                w.remove_window();
            })
            .unwrap();
            cx.run_until_parked();
            println!(
                "stored image {width} {}: exact scoped reader/static completion/BGRA paint/fit/actual/source copy/previous/back/JPEG/GIF/WebP refusal/malformed/cleanup pass",
                mode.name()
            );
        }
    }
    assert!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.starts_with("GET "))
    );
}
