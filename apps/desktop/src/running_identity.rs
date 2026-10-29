//! Identities of the executing app and the connected daemon, not staged files.
use crate::local_client::ConnectedDaemon;

pub(crate) struct RunningApp {
    pub(crate) version: String,
    pub(crate) build: Option<String>,
}

impl RunningApp {
    pub(crate) fn current() -> Self {
        Self {
            version: crate::diagnostics::Build::current().version().into(),
            build: pilot_desktop_updater::helper::compiled_trust()
                .ok()
                .map(|trust| trust.current_build),
        }
    }

    pub(crate) fn display(&self) -> String {
        match &self.build {
            Some(build) => format!("{} (Build {build})", self.version),
            None => format!("{} (development build)", self.version),
        }
    }
}

pub(crate) fn daemon_display(daemon: &ConnectedDaemon) -> String {
    match daemon {
        ConnectedDaemon::Connected(Some(version)) => version.to_string(),
        ConnectedDaemon::Connected(None) => "Version unknown".into(),
        ConnectedDaemon::NotConnected => "Not connected".into(),
    }
}

pub(crate) fn identity_row(
    id: &'static str,
    label: &'static str,
    value: String,
) -> impl gpui_kit::IntoElement {
    use gpui_kit::{
        InteractiveElement, ParentElement, StatefulInteractiveElement, Styled, TestSupportExt, div,
    };
    let name = format!("{label}: {value}");
    div()
        .id(id)
        .test_support()
        .min_w_0()
        .aria_label(name.clone())
        .child(crate::ui::text(crate::ui::Text::Caption, name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executing_identity_is_independent_of_candidates_and_daemon() {
        let app = RunningApp::current();
        let package: serde_json::Value =
            serde_json::from_str(include_str!("../../../package.json")).unwrap();
        assert_eq!(app.version, package["version"].as_str().unwrap());
        assert_eq!(
            app.build.as_deref(),
            option_env!("PILOT_NEXT_UPDATER_BUILD")
                .filter(|_| pilot_desktop_updater::helper::compiled_trust().is_ok())
        );
        let display = app.display();
        let replaced_bundle = RunningApp {
            version: "99.0".into(),
            build: Some("999".into()),
        };
        assert_ne!(display, replaced_bundle.display());
        assert_eq!(display, RunningApp::current().display());
        assert_eq!(
            daemon_display(&ConnectedDaemon::Connected(Some("1.2.3".into()))),
            "1.2.3"
        );
        assert_eq!(
            daemon_display(&ConnectedDaemon::Connected(None)),
            "Version unknown"
        );
        assert_eq!(
            daemon_display(&ConnectedDaemon::NotConnected),
            "Not connected"
        );
    }
}
