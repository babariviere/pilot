//! Read-only filesystem/native-identity check. No app launch or capsule publication.
//! Supply updater-inputs.json from a separately authenticated release, not a feed response.
#[cfg(all(target_os = "macos", feature = "native-macos"))]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Native Security checks deliberately refuse UI/main-thread execution.
    std::thread::spawn(|| preflight().map_err(|error| error.to_string()))
        .join()
        .map_err(|_| "Preflight worker panicked")?
        .map_err(Into::into)
}

#[cfg(all(target_os = "macos", feature = "native-macos"))]
fn preflight() -> Result<(), Box<dyn std::error::Error>> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use pilot_desktop_updater::{installer, installer::Platform, manifest::Trust};
    use serde::Deserialize;
    use std::path::PathBuf;

    #[derive(Deserialize)]
    struct Inputs {
        configuration: Configuration,
    }
    #[derive(Deserialize)]
    struct Configuration {
        repository: String,
        application_id: String,
        build: String,
        public_key: String,
        code_requirement: String,
    }
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 {
        return Err(
            "Usage: install-preflight ABSOLUTE_APP_PATH VERIFIED_UPDATER_INPUTS_JSON".into(),
        );
    }
    let target = PathBuf::from(&args[0]);
    let config: Inputs = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    let config = config.configuration;
    let trust = Trust {
        repository: config.repository,
        application_id: config.application_id,
        channel: "desktop-stable".into(),
        current_build: config.build,
        bundle_name: "Pilot Next.app".into(),
        public_key: STANDARD
            .decode(config.public_key)?
            .try_into()
            .map_err(|_| "Invalid key length")?,
        code_requirement: config.code_requirement,
    };
    trust
        .validate()
        .map_err(|error| format!("Trust configuration: {error:?}"))?;
    installer::validate_target(&target, &trust)
        .map_err(|error| format!("Installation filesystem: {error:?}"))?;
    installer::MacPlatform
        .verify(&target, &trust, &trust.current_build, None)
        .map_err(|error| format!("Native signature/identity: {error:?}"))?;
    println!("Installation filesystem and native identity passed. No app or runtime was started.");
    Ok(())
}

#[cfg(not(all(target_os = "macos", feature = "native-macos")))]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    Err("Requires macOS and --features native-macos".into())
}
