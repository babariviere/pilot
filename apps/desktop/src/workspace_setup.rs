//! Passive setup failure projection. Setup is separate from the agent's run outcome.
use serde_json::Value;

pub(crate) fn failure(summary: &Value) -> Option<String> {
    let setup = &summary["workspaceSetup"];
    if setup["state"] != "failed" {
        return None;
    }
    Some(
        setup["detail"]
            .as_str()
            .filter(|text| !text.trim().is_empty())
            .unwrap_or("Workspace setup failed. Dependencies may not be ready.")
            .chars()
            .take(512)
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_explicit_setup_failure_is_shown() {
        for state in ["pending", "ok", "cancelled", "future"] {
            assert_eq!(
                failure(&json!({"workspaceSetup":{"state":state,"detail":"not failure"}})),
                None
            );
        }
        assert_eq!(
            failure(
                &json!({"workspaceSetup":{"state":"failed","detail":"Setup failed: Install (exit 1)"}})
            ),
            Some("Setup failed: Install (exit 1)".into())
        );
        assert_eq!(
            failure(&json!({"workspaceSetup":{"state":"failed","detail":"界".repeat(900)}}))
                .unwrap()
                .chars()
                .count(),
            512
        );
    }
}
