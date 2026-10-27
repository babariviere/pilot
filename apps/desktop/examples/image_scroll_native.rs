//! Opt-in hidden native image-heavy scroll journey; synthetic data only.
fn main() {
    // A visible foreground app's main thread runs user-interactive. Without this,
    // a hidden process can be scheduled for efficiency and inflate draw times.
    #[cfg(target_os = "macos")]
    unsafe {
        libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_USER_INTERACTIVE, 0);
    }
    gpui_kit::Application::with_platform(gpui_kit::platform::current_platform(false))
        .with_assets(pilot_desktop::ChromeAssets)
        .with_windowing(gpui_kit::WindowingRequest::Headless)
        .run(|cx| {
            gpui_kit::init(cx);
            pilot_desktop::init_appearance(cx);
            pilot_desktop::TranscriptView::bind_keys(cx);
            pilot_desktop::run_native_image_scroll_probe(cx);
        });
}
