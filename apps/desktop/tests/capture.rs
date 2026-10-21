//! Opt-in private real-chat pixels. No mutation client, draft store or visible window.
use gpui_kit::{
    AppContext, Bounds, HeadlessAppContext, WindowBounds, WindowOptions, assets::Assets, px, size,
    test::TestWindowExt,
};
use pilot_desktop::{LocalOptions, LocalViewer, read_local_capture};
use std::{
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    sync::Arc,
};
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 4 || args[0] != "--chat" || args[2] != "--output" {
        eprintln!("Usage: capture --chat <exact Local chat ID> --output <private PNG path>");
        std::process::exit(2);
    }
    let output = PathBuf::from(&args[3]);
    let parent = output.parent().expect("output parent");
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    if !parent.exists() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)
            .expect("new private capture directory");
    }
    let metadata = std::fs::symlink_metadata(parent).expect("capture directory metadata");
    assert!(
        metadata.is_dir()
            && !metadata.file_type().is_symlink()
            && metadata.permissions().mode() & 0o077 == 0
            && metadata.uid() == unsafe { libc::geteuid() },
        "capture output requires an owned private directory; existing permissions are never changed"
    );
    let capture = read_local_capture(
        LocalOptions::discover().expect("existing Local identity"),
        &args[1],
    )
    .unwrap_or_else(|error| {
        eprintln!("{error}");
        std::process::exit(1)
    });
    let mut cx = HeadlessAppContext::with_platform(
        gpui_kit::platform::current_platform(true).text_system(),
        Arc::new(Assets),
        gpui_kit::platform::current_headless_renderer,
    );
    cx.update(gpui_kit::init);
    let (handle, view) = cx
        .update(|cx| {
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Default::default(),
                        size(px(960.), px(760.)),
                    ))),
                    show: false,
                    focus: false,
                    ..Default::default()
                },
                cx,
                |window, cx| cx.new(|cx| LocalViewer::captured(capture, window, cx)),
            )
        })
        .expect("offscreen production view");
    cx.run_until_parked();
    cx.update_window(handle, |_, window, cx| window.render_frame(cx))
        .unwrap();
    cx.run_until_parked();
    assert!(
        cx.update(|cx| view.read(cx).text_parsers_ready(cx)),
        "capture source must be parsed, not an empty pending frame"
    );
    let shot = cx
        .capture_screenshot(handle)
        .expect("native renderer capture");
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&output)
        .expect("new private output path (never overwrite)");
    // Encode through the exclusively created handle, never reopen/follow a swapped path.
    shot.write_to(&mut file, image::ImageFormat::Png)
        .expect("save private pixels");
    file.sync_all().expect("flush private pixels");
    println!(
        "Private read-only production-view capture saved. Live window scroll/expansion/drafts are not captured. No chat content/IDs logged; do not publish this image."
    );
}
