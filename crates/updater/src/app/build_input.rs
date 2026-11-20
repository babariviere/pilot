//! Read-only compiled input evidence. This is not a signature or startup receipt.
use crate::{Error, helper::compiled_trust};
use serde_json::{Value, json};

/// True only for the single diagnostic argument, never a transaction prefix.
pub fn requested() -> bool {
    let mut arguments = std::env::args_os().skip(1);
    arguments.next().as_deref() == Some(std::ffi::OsStr::new("--build-input-receipt"))
        && arguments.next().is_none()
}

/// Report values from the updater dependency linked into this executable.
/// Missing build-source evidence is reported as empty, never inferred from Git.
///
/// # Errors
/// Refuses partial or invalid compiled updater configuration and output failures.
pub fn write() -> Result<(), Error> {
    use std::io::Write as _;
    let value = receipt()?;
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    serde_json::to_writer(&mut output, &value).map_err(|_| Error::Filesystem)?;
    writeln!(output).map_err(|_| Error::Filesystem)
}

fn receipt() -> Result<Value, Error> {
    let configuration = if [
        option_env!("PILOT_NEXT_UPDATER_PUBLIC_KEY"),
        option_env!("PILOT_NEXT_UPDATER_REPOSITORY"),
        option_env!("PILOT_NEXT_UPDATER_APPLICATION_ID"),
        option_env!("PILOT_NEXT_UPDATER_BUILD"),
        option_env!("PILOT_NEXT_UPDATER_CODE_REQUIREMENT"),
    ]
    .iter()
    .all(Option::is_none)
    {
        json!({"schema":1,"mode":"unconfigured"})
    } else {
        let trust = compiled_trust()?;
        json!({"schema":1,"mode":"configured",
            "public_key":option_env!("PILOT_NEXT_UPDATER_PUBLIC_KEY"),
            "repository":trust.repository,"application_id":trust.application_id,
            "build":trust.current_build,"code_requirement":trust.code_requirement})
    };
    Ok(json!({"schema":1,"kind":"compiled-build-input",
        "source":env!("PILOT_BUILD_SOURCE"),"recipe":env!("PILOT_BUILD_RECIPE"),
        "target":env!("PILOT_BUILD_TARGET"),"profile":env!("PILOT_BUILD_PROFILE"),
        "compiler":env!("PILOT_BUILD_COMPILER"),"updater_configuration":configuration}))
}

#[cfg(test)]
mod tests {
    #[test]
    fn diagnostic_is_compiled_evidence_not_installability() {
        let value = super::receipt().unwrap();
        assert_eq!(value["kind"], "compiled-build-input");
        assert_eq!(value["target"], env!("PILOT_BUILD_TARGET"));
        assert_eq!(value["source"], env!("PILOT_BUILD_SOURCE"));
        assert!(!value["compiler"].as_str().unwrap().is_empty());
        assert!(value.get("installed").is_none());
        assert!(value.get("signature").is_none());
    }
}
