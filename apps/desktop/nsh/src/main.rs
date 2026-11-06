#[cfg(target_os = "macos")]
mod native;

#[cfg(target_os = "macos")]
fn main() -> std::process::ExitCode {
    use nsh_platform_macos as platform;
    use pilot_desktop::{LocalOptions, nsh_adapter::Adapter};
    use std::path::PathBuf;
    let args: Vec<_> = std::env::args().collect();
    let value = |flag: &str| {
        args.windows(2)
            .find(|pair| pair[0] == flag)
            .map(|pair| pair[1].clone())
    };
    let fixture_mode = args.iter().any(|a| a == "--fixture");
    #[cfg(feature = "native-probes")]
    let fixture = fixture_mode.then(pilot_nsh::fixture::Fixture::start);
    if !fixture_mode && !args.iter().any(|a| a == "--local") {
        eprintln!(
            "Use --local to connect to the existing daemon, or --fixture with native-probes. No daemon is started."
        );
        return std::process::ExitCode::FAILURE;
    }
    let state = match value("--state-dir").map(PathBuf::from) {
        Some(state) => state,
        None if fixture_mode => {
            std::env::temp_dir().join(format!("pilot-nsh-fixture-{}", std::process::id()))
        }
        None => match Adapter::default_state() {
            Ok(state) => state,
            Err(e) => {
                eprintln!("{e}");
                return std::process::ExitCode::FAILURE;
            }
        },
    };
    let options = if fixture_mode {
        #[cfg(feature = "native-probes")]
        {
            fixture.as_ref().expect("fixture mode").options()
        }
        #[cfg(not(feature = "native-probes"))]
        {
            eprintln!("Build with --features native-probes for isolated fixtures.");
            return std::process::ExitCode::FAILURE;
        }
    } else {
        match LocalOptions::discover() {
            Ok(options) => options,
            Err(e) => {
                eprintln!("{e}");
                return std::process::ExitCode::FAILURE;
            }
        }
    };
    let capture = value("--capture").map(PathBuf::from);
    let prompt_probe = args.iter().any(|a| a == "--check-prompts");
    #[cfg(feature = "native-probes")]
    if prompt_probe && let Some(fixture) = &fixture {
        fixture.question("a",40,serde_json::json!({"question":"Which checks should run? 日本語", "context":"Choose explicitly. Your ordinary draft stays separate.","blocking":true,"multiSelect":true,"options":[{"label":"Typecheck","detail":"Check shared types","suggested":true},{"label":"Tests","detail":"Run focused checks"}]}));
        for (id, mode) in [("b", "write"), ("coordinator", "read")] {
            fixture.question(id,40,serde_json::json!({"question":"Agent prose does not define the grant", "context":"Needed for the requested query.","databaseAccess":{"id":"grant-1","env":"Development 日本語","mode":mode}}));
        }
    }
    if capture.is_some() && !fixture_mode {
        eprintln!("Automated captures require --fixture. No live actions are allowed.");
        return std::process::ExitCode::FAILURE;
    }
    let (close, requests) = async_channel::bounded(1);
    let (closed, replies) = async_channel::bounded(1);
    let config = pilot_nsh::Config {
        options,
        state: state.clone(),
        close: requests,
        closed,
    };
    let native_options = platform::AppOptions {
        title: "Pilot Next · NSH chat slice".into(),
        app_id: "dev.pilot.next.nsh".into(),
        size: (
            value("--width")
                .and_then(|s| s.parse().ok())
                .unwrap_or(1180),
            820,
        ),
        appearance: if args.iter().any(|a| a == "--dark") {
            platform::Appearance::Dark
        } else {
            platform::Appearance::Light
        },
        data_dir: Some(state.join("nsh")),
        cache: nsh_engine::CacheOptions::off(),
        ..Default::default()
    };
    let result = native::run(
        native_options,
        config,
        close,
        replies,
        capture,
        args.iter().any(|a| a == "--check-saved-draft"),
        prompt_probe,
    );
    #[cfg(feature = "native-probes")]
    if prompt_probe && let Some(fixture) = &fixture {
        let state = fixture.state.lock().expect("fixture state");
        assert_eq!(
            state.decisions,
            [
                (
                    "b".into(),
                    serde_json::json!({"id":"grant-1","allow":false})
                ),
                (
                    "coordinator".into(),
                    serde_json::json!({"id":"grant-1","allow":true})
                )
            ]
        );
        assert_eq!(state.envelopes.len(), 1);
        let payload: serde_json::Value =
            serde_json::from_str(state.envelopes[0]["payload"].as_str().expect("payload"))
                .expect("payload JSON");
        assert_eq!(payload["questionReplyId"], 40);
        assert_eq!(
            payload["message"],
            "- Typecheck\n- Tests\n\n日本語 👩🏽‍💻 cafe\u{301}\nsecond line"
        );
        assert_eq!(state.stops, ["a"]);
    }
    result
}

#[cfg(not(target_os = "macos"))]
fn main() -> std::process::ExitCode {
    eprintln!("NSH chat slice is qualified on macOS only. Linux remains unavailable.");
    std::process::ExitCode::FAILURE
}
