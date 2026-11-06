//! Standalone runner, with optional hidden native captures.
mod native;

use nsh_platform_macos as platform;
use std::path::PathBuf;

fn main() -> std::process::ExitCode {
    let args: Vec<_> = std::env::args().collect();
    let width = args
        .windows(2)
        .find(|pair| pair[0] == "--width")
        .map_or(1180, |pair| pair[1].parse().expect("numeric width"));
    let options = platform::AppOptions {
        title: "Pilot · NSH prototype (synthetic)".into(),
        app_id: "dev.pilot.synthetic.nsh-workbench".into(),
        size: (width, 820),
        appearance: if args.iter().any(|a| a == "--dark") {
            platform::Appearance::Dark
        } else {
            platform::Appearance::Light
        },
        data_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("output/state")),
        cache: nsh_engine::CacheOptions::off(),
        ..Default::default()
    };
    if let Some(pair) = args.windows(2).find(|pair| pair[0] == "--capture") {
        native::capture(options, PathBuf::from(&pair[1]));
        std::process::ExitCode::SUCCESS
    } else {
        platform::run_app(
            platform::AppSource::Rust(pilot_nsh_workbench::root()),
            options,
        )
    }
}
