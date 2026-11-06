#![cfg(feature = "native-probes")]
use nsh_engine::EngineConfig;
use nsh_testing::Headless;
use pilot_desktop::nsh_adapter::{Adapter, ImagePreview, Snapshot};
use pilot_nsh::{Config, fixture::Fixture};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
                "nsh-images-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            )))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
async fn until(a: &mut Adapter, predicate: impl Fn(&Snapshot) -> bool) -> Snapshot {
    let events = a.events();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let s = a.snapshot();
            if predicate(&s) {
                return s;
            }
            a.accept(events.next().await.unwrap());
        }
    })
    .await
    .unwrap_or_else(|_| panic!("adapter deadline: {:?}", a.snapshot()))
}
async fn open(a: &mut Adapter, id: &str) -> Snapshot {
    until(a, |s| {
        s.sidebar.iter().any(|r| r.session.as_deref() == Some(id))
    })
    .await;
    assert!(a.open(id));
    until(a, |s| {
        s.messages.iter().filter(|m| m.image.is_some()).count() == 4 && s.history_loaded
    })
    .await
}

#[tokio::test]
async fn all_stored_images_keep_upright_geometry_first_frame_bytes_and_exact_ownership() {
    let fixture = Fixture::start();
    fixture.images("a");
    fixture.images("b");
    let temp = Temp::new();
    let mut a = Adapter::start(fixture.options(), temp.0.clone());
    let s = open(&mut a, "a").await;
    let location = s.location.unwrap();
    let images: Vec<_> = s.messages.iter().filter_map(|m| m.image.clone()).collect();
    let originals = pilot_desktop::nsh_adapter::synthetic_images();
    for (index, (image, size)) in images
        .iter()
        .zip([(400, 600), (960, 480), (300, 600), (960, 480)])
        .enumerate()
    {
        assert_eq!(image.size(), Some(size));
        assert!(a.image_current(&location, image));
        assert!(image.identity().contains("test-daemon"));
        assert!(image.identity().contains("test-lineage"));
        let p = image
            .preview(Arc::new(AtomicBool::new(false)))
            .await
            .unwrap();
        assert_eq!((p.width, p.height), size);
        assert_eq!(p.first_frame, index == 3);
        assert_eq!(
            p.original.as_str(),
            format!(
                "data:{};base64,{}",
                originals[index]["mimeType"].as_str().unwrap(),
                originals[index]["data"].as_str().unwrap()
            )
        );
        assert!(p.png.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert_eq!(
            u32::from_be_bytes(p.png[16..20].try_into().unwrap()),
            size.0
        );
        assert_eq!(
            u32::from_be_bytes(p.png[20..24].try_into().unwrap()),
            size.1
        );
    }
    open(&mut a, "b").await;
    assert!(!a.image_current(&location, &images[0]));
    let back = open(&mut a, "a").await;
    assert!(
        !a.image_current(&location, &images[0]),
        "old navigation generation never revives"
    );
    assert!(a.image_current(&back.location.unwrap(), &images[0]));
    assert!(a.close());
    until(&mut a, |s| s.closed).await;
    assert!(fixture.state.lock().unwrap().envelopes.is_empty());
}

#[tokio::test]
async fn malformed_unsupported_and_oversized_sources_never_load_external_content() {
    use serde_json::json;
    let fixture = Fixture::start();
    fixture.images("a");
    fixture
        .state
        .lock()
        .unwrap()
        .histories
        .get_mut("a")
        .unwrap()[1]["model"][0]["content"] = json!([
        {"type":"image","mimeType":"image/png","data":"AAAA"},
        {"type":"image","mimeType":"image/webp","data":"AAAA"},
        {"type":"image","mimeType":"image/png","url":"https://invalid.example/image.png","path":"/never/read.png"},
        {"type":"image","mimeType":"image/png","data":"A".repeat((16_usize*1024*1024).div_ceil(3)*4+64)}
    ]);
    let temp = Temp::new();
    let mut a = Adapter::start(fixture.options(), temp.0.clone());
    let s = open(&mut a, "a").await;
    let images: Vec<_> = s.messages.iter().filter_map(|m| m.image.as_ref()).collect();
    assert!(images[1].problem().unwrap().contains("WebP"));
    assert!(images[2].problem().unwrap().contains("Paths and URLs"));
    for image in images {
        assert!(
            image
                .preview(Arc::new(AtomicBool::new(false)))
                .await
                .is_err()
        );
    }
    assert!(
        fixture
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .all(|(_, p)| !p.contains("never") && !p.contains("invalid.example"))
    );
    assert!(a.close());
    until(&mut a, |s| s.closed).await;
}

#[tokio::test]
async fn cancelled_decode_and_replaced_source_cannot_become_current() {
    let fixture = Fixture::start();
    fixture.images("a");
    let temp = Temp::new();
    let mut a = Adapter::start(fixture.options(), temp.0.clone());
    let s = open(&mut a, "a").await;
    let location = s.location.unwrap();
    let image = s.messages.iter().find_map(|m| m.image.clone()).unwrap();
    let stop = Arc::new(AtomicBool::new(true));
    // A cancelled queued receiver must complete too, not wait forever.
    let future = image.preview(stop.clone());
    assert!(
        tokio::time::timeout(Duration::from_secs(3), future)
            .await
            .unwrap()
            .is_err()
    );
    stop.store(false, Ordering::Release);
    let admission = pilot_desktop::nsh_adapter::hold_image_previews().unwrap();
    let pending = tokio::spawn({
        let image = image.clone();
        let stop = stop.clone();
        async move { image.preview(stop).await }
    });
    assert!(a.open("b"));
    stop.store(true, Ordering::Release);
    drop(admission);
    let _ = pending.await.unwrap();
    assert!(!a.image_current(&location, &image));
    // Same entry/block with new bytes must not qualify the old preview.
    fixture
        .state
        .lock()
        .unwrap()
        .histories
        .get_mut("a")
        .unwrap()[1]["model"][0]["content"][1] =
        pilot_desktop::nsh_adapter::synthetic_images()[1].clone();
    let changed = open(&mut a, "a").await;
    assert!(!a.image_current(&changed.location.unwrap(), &image));
    assert!(a.close());
    until(&mut a, |s| s.closed).await;
}

#[test]
fn nsh_image_selection_zoom_pan_fit_reset_and_exact_copy_use_production_rows() {
    let fixture = Fixture::start();
    fixture.images("a");
    fixture.images("b");
    let temp = Temp::new();
    let (_close, requests) = async_channel::bounded(1);
    let (closed, _replies) = async_channel::bounded(1);
    let copied = Arc::new(Mutex::new(None::<ImagePreview>));
    let sink = copied.clone();
    let root = pilot_nsh::root_with_image_copy(
        Config {
            options: fixture.options(),
            state: temp.0.clone(),
            close: requests,
            closed,
        },
        move |p| *sink.lock().unwrap() = Some(p.clone()),
    );
    let mut engine = EngineConfig::new(root);
    engine.clock = nsh_core::time::Clock::manual(std::time::UNIX_EPOCH);
    engine.environment.os = nsh_core::platform::Os::MacOs;
    let mut app = Headless::start(engine).unwrap();
    app.wait_for("label:Open chat a").unwrap();
    app.press("label:Open chat a").unwrap();
    app.wait_for("id:inline-image-pixels").unwrap();
    app.wait_until("first image decoded", Duration::from_secs(15), |screen| {
        screen
            .enabled("label:Expand image, block 1")
            .unwrap_or(false)
    })
    .unwrap();
    app.press("label:Expand image, block 1").unwrap();
    app.wait_for("id:image-reader").unwrap();
    for title in [
        "Zoom in",
        "Zoom out",
        "Actual size (100%)",
        "Fit image",
        "Reset image",
    ] {
        app.press(&format!("label:{title}")).unwrap();
    }
    app.press("label:Actual size (100%)").unwrap();
    app.press_key("mod+shift+=").unwrap();
    app.wait_for("125%").unwrap();
    app.press("label:Actual size (100%)").unwrap();
    app.press_key("Alt+ArrowDown").unwrap();
    app.press("label:Copy image in reader").unwrap();
    let first = copied
        .lock()
        .unwrap()
        .clone()
        .expect("image, not message text, owns Copy");
    assert!(first.png.starts_with(b"\x89PNG"));
    app.press("label:Copy image source").unwrap();
    assert_eq!(app.screen().clipboard(), Some(first.original.as_str()));
    app.press("label:Reset image").unwrap();
    app.press("label:Close image (Escape)").unwrap();
    app.press("label:Open chat b").unwrap();
    app.wait_for("id:inline-image-pixels").unwrap();
    app.press("label:Open chat a").unwrap();
    app.wait_for("id:inline-image-pixels").unwrap();
    app.wait_until(
        "returned image decoded",
        Duration::from_secs(15),
        |screen| {
            screen
                .enabled("label:Expand image, block 1")
                .unwrap_or(false)
        },
    )
    .unwrap();
    app.press("label:Expand image, block 1").unwrap();
    app.wait_for("id:image-reader").unwrap();
    app.press_key("Meta+c").unwrap();
    assert_eq!(copied.lock().unwrap().as_ref().unwrap().png, first.png);
    app.press("label:Close image (Escape)").unwrap();
    assert!(fixture.state.lock().unwrap().envelopes.is_empty());
}
