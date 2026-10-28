use nsh_chat_prototype::screen;
use nsh_platform_macos as platform;
use std::path::PathBuf;
mod native_probe;
mod resources;

fn main() -> std::process::ExitCode {
    env_logger::init();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let options = platform::AppOptions {
        title: "Conversation study · NSH Rust AppKit".into(),
        app_id: "dev.pilot.synthetic.nsh-chat".into(),
        size: (1180, 820),
        asset_base: Some(platform::AssetBase::Directory(root)),
        data_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("output/state")),
        cache: nsh_engine::CacheOptions::off(),
        ..Default::default()
    };
    if std::env::args().any(|a| a == "--probe" || a == "--bench" || a == "--checks") {
        native_probe::run(screen::root(), options)
    } else {
        platform::run_app(platform::AppSource::Rust(screen::root()), options)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nsh_core::geometry::{Points, Size};
    use nsh_engine::EngineConfig;

    #[test]
    fn rust_navigation_draft_and_mission_form() {
        let config = EngineConfig {
            viewport: Size::new(Points(1180.), Points(820.)),
            ..EngineConfig::new(screen::root())
        };
        let mut app = nsh_testing::Headless::start(config).unwrap();
        app.wait_for("id:composer").unwrap();
        let draft = "日本語 👩🏽‍💻 cafe\u{301}";
        app.type_text("id:composer", draft).unwrap();
        app.press("label:Open another thought").unwrap();
        app.type_text("id:composer", "second draft").unwrap();
        app.press("label:Open reading surface").unwrap();
        assert_eq!(app.screen().input_text("id:composer").unwrap(), Some(draft));
        app.press("label:Edit mission").unwrap();
        app.clear("label:Mission title").unwrap();
        app.type_text("label:Mission title", "A shared form")
            .unwrap();
        app.press("label:Save changes").unwrap();
        app.wait_for("Saved in this synthetic process.").unwrap();
        app.press("label:Close").unwrap();
        app.press("label:Edit mission").unwrap();
        assert_eq!(
            app.screen().input_text("label:Mission title").unwrap(),
            Some("A shared form")
        );
    }

    #[test]
    fn streaming_survives_navigation_without_updating_disposed_rows() {
        let probe = screen::probe();
        let config = EngineConfig {
            viewport: Size::new(Points(1180.), Points(820.)),
            ..EngineConfig::new(screen::root())
        };
        let mut app = nsh_testing::Headless::start(config).unwrap();
        app.wait_for("id:composer").unwrap();
        app.type_text("id:composer", "Keep this draft 👩🏽‍💻").unwrap();
        probe.commands.send("replay".into()).unwrap();
        probe.commands.send("chat1".into()).unwrap();
        app.wait(std::time::Duration::from_millis(150)).unwrap();
        probe.commands.send("chat0".into()).unwrap();
        app.wait(std::time::Duration::from_millis(150)).unwrap();
        probe.commands.send("stop".into()).unwrap();
        probe.commands.send("state".into()).unwrap();
        let state = probe
            .reports
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap();
        assert_eq!(state["chat"], 0);
        assert_eq!(state["draft"], "Keep this draft 👩🏽‍💻");
        assert_eq!(state["rows"], 1001);
    }
}
