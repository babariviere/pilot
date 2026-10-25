use gpui_kit::{AppContext, Bounds, WindowBounds, WindowOptions, px, size};
use pilot_desktop::{
    BundledRuntimeView, LocalOptions, LocalViewer, TranscriptView, fence_fixture, giant_fixture,
};

enum Desktop {
    Fixture(gpui_kit::Entity<TranscriptView>),
    Local(gpui_kit::Entity<LocalViewer>),
    Bundled(gpui_kit::Entity<BundledRuntimeView>),
}
impl gpui_kit::Render for Desktop {
    fn render(
        &mut self,
        _: &mut gpui_kit::Window,
        _: &mut gpui_kit::Context<Self>,
    ) -> impl gpui_kit::IntoElement {
        use gpui_kit::IntoElement;
        match self {
            Self::Fixture(view) => view.clone().into_any_element(),
            Self::Local(view) => view.clone().into_any_element(),
            Self::Bundled(view) => view.clone().into_any_element(),
        }
    }
}

fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.as_slice() == ["--local-check"] {
        let result = LocalOptions::discover().and_then(pilot_desktop::check_local_read);
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    let local = args.as_slice() == ["--local"];
    let bundled = pilot_desktop::bundled_runtime::requested(
        &args,
        &std::env::current_exe().unwrap_or_else(|_| {
            eprintln!("Cannot locate this app executable.");
            std::process::exit(1);
        }),
    );
    let options = if local {
        Some(LocalOptions::discover().unwrap_or_else(|error| {
            eprintln!("{error}");
            std::process::exit(1);
        }))
    } else {
        None
    };
    let extra = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [] => None,
        ["--local"] => None,
        ["--bundled"] => None,
        ["--fixture", "giant"] => Some(giant_fixture()),
        ["--fixture", "fence"] => Some(fence_fixture()),
        ["--help"] => {
            println!(
                "Pilot Next.\n--bundled: guarded bundled Local runtime, arm64 macOS only.\n--local: explicit existing-daemon mode, Local chats/create/send/Stop and private durable drafts.\nExisting loopback API, no request authentication. Full hello identity is pinned.\nNo approvals, archive or read-status writes. --local-check stays read-only.\nNo args: packaged app uses its guarded runtime; unbundled executable uses a synthetic fixture.\n--fixture giant: 1 MiB/2,000 paragraphs. --fixture fence: 5,000 code lines.\nClose window or Cmd/Ctrl-Q to save and exit."
            );
            return;
        }
        _ => {
            eprintln!("Unknown arguments. Use --help.");
            std::process::exit(2);
        }
    };
    #[cfg(target_os = "linux")]
    if let Err(error) = wayland_preflight() {
        eprintln!("Native Wayland required: {error}. No X11/headless fallback.");
        std::process::exit(1);
    }
    #[cfg(target_os = "linux")]
    let application = gpui_kit::platform::linux(gpui_kit::WindowingModes::WAYLAND);
    #[cfg(target_os = "macos")]
    let application = gpui_kit::application();
    application
        .with_assets(pilot_desktop::ChromeAssets)
        .run(move |cx| {
            gpui_kit::init(cx);
            pilot_desktop::init_appearance(cx);
            TranscriptView::bind_keys(cx);
            LocalViewer::bind_keys(cx);
            // Initial window geometry is a physical platform boundary, not a UI token.
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                        None,
                        size(px(960.), px(760.)),
                        cx,
                    ))),
                    ..Default::default()
                },
                cx,
                |window, cx| {
                    pilot_desktop::follow_appearance(window, cx);
                    window.set_window_title(if bundled {
                        "Pilot Next · Starting Local"
                    } else if local {
                        "Pilot Next · Local"
                    } else {
                        "Pilot Next · synthetic fixture"
                    });
                    cx.new(|cx| {
                        if bundled {
                            Desktop::Bundled(cx.new(|cx| BundledRuntimeView::new(window, cx)))
                        } else if let Some(options) = options {
                            Desktop::Local(cx.new(|cx| LocalViewer::new(options, window, cx)))
                        } else {
                            Desktop::Fixture(
                                cx.new(|cx| TranscriptView::with_fixture(extra, window, cx)),
                            )
                        }
                    })
                },
            )
            .expect("open fixture window");
            cx.on_window_closed(|cx, _| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();
            cx.activate(true);
        });
}

#[cfg(target_os = "linux")]
fn wayland_preflight() -> Result<(), Box<dyn std::error::Error>> {
    use std::{os::unix::net::UnixStream, path::PathBuf};
    // Validate a real compositor connection, not just the presence of DISPLAY.
    // An inherited WAYLAND_SOCKET-only launch is intentionally unsupported in A1.
    let display =
        PathBuf::from(std::env::var_os("WAYLAND_DISPLAY").ok_or("WAYLAND_DISPLAY is unset")?);
    let socket = if display.is_absolute() {
        display
    } else {
        PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR").ok_or("XDG_RUNTIME_DIR is unset")?)
            .join(display)
    };
    UnixStream::connect(socket)?;
    Ok(())
}
